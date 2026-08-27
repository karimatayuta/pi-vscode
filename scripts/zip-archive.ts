import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	readonly name: string;
	readonly compressedBytes: number;
	readonly uncompressedBytes: number;
	readonly unixMode: number;
	readonly compressionMethod: number;
	readonly localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x0605_4b50;
const CENTRAL_DIRECTORY_ENTRY = 0x0201_4b50;
const LOCAL_FILE_HEADER = 0x0403_4b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;
export const MAX_ZIP_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 55 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 6_500;
const MAX_ENTRY_OUTPUT_BYTES = MAX_EXTRACTED_BYTES;

function findEndOfCentralDirectory(archive: Buffer): number {
	const firstCandidate = Math.max(0, archive.byteLength - MAX_EOCD_SEARCH_BYTES);
	for (let offset = archive.byteLength - 22; offset >= firstCandidate; offset -= 1) {
		if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
	}
	throw new Error("The package is not a valid ZIP archive (central directory not found).");
}

export function readZipEntries(archive: Buffer): readonly ZipEntry[] {
	const endOffset = findEndOfCentralDirectory(archive);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralDirectoryBytes = archive.readUInt32LE(endOffset + 12);
	const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
	const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
	if (centralDirectoryEnd > endOffset || centralDirectoryEnd > archive.byteLength) {
		throw new Error("The package has an invalid central directory range.");
	}

	const decoder = new TextDecoder("utf-8", { fatal: true });
	const entries: ZipEntry[] = [];
	let offset = centralDirectoryOffset;
	while (offset < centralDirectoryEnd) {
		if (
			offset + 46 > centralDirectoryEnd ||
			archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY
		) {
			throw new Error(`The package has an invalid ZIP entry at byte ${offset}.`);
		}
		const nameBytes = archive.readUInt16LE(offset + 28);
		const extraBytes = archive.readUInt16LE(offset + 30);
		const commentBytes = archive.readUInt16LE(offset + 32);
		const externalAttributes = archive.readUInt32LE(offset + 38);
		const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
		if (nextOffset > centralDirectoryEnd) {
			throw new Error("The package has a truncated ZIP entry.");
		}
		entries.push({
			name: decoder.decode(archive.subarray(offset + 46, offset + 46 + nameBytes)),
			compressedBytes: archive.readUInt32LE(offset + 20),
			uncompressedBytes: archive.readUInt32LE(offset + 24),
			unixMode: externalAttributes >>> 16,
			compressionMethod: archive.readUInt16LE(offset + 10),
			localHeaderOffset: archive.readUInt32LE(offset + 42),
		});
		offset = nextOffset;
	}
	if (entries.length !== entryCount) {
		throw new Error(`ZIP entry count mismatch: expected ${entryCount}, found ${entries.length}.`);
	}
	return entries;
}

export function readZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
	const offset = entry.localHeaderOffset;
	if (offset + 30 > archive.byteLength || archive.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
		throw new Error(`Invalid local ZIP header for ${entry.name}.`);
	}
	const nameBytes = archive.readUInt16LE(offset + 26);
	const extraBytes = archive.readUInt16LE(offset + 28);
	const nameOffset = offset + 30;
	const nameEnd = nameOffset + nameBytes;
	if (nameEnd > archive.byteLength) throw new Error(`Truncated local ZIP name for ${entry.name}.`);
	const localName = new TextDecoder("utf-8", { fatal: true }).decode(
		archive.subarray(nameOffset, nameEnd),
	);
	if (localName !== entry.name) {
		throw new Error(`Local and central ZIP names differ for ${entry.name}.`);
	}
	const dataOffset = offset + 30 + nameBytes + extraBytes;
	const dataEnd = dataOffset + entry.compressedBytes;
	if (dataEnd > archive.byteLength) throw new Error(`Truncated ZIP payload for ${entry.name}.`);
	const compressed = archive.subarray(dataOffset, dataEnd);
	const value =
		entry.compressionMethod === 0
			? Buffer.from(compressed)
			: entry.compressionMethod === 8
				? inflateRawSync(compressed, {
						maxOutputLength: Math.min(entry.uncompressedBytes + 1, MAX_ENTRY_OUTPUT_BYTES + 1),
					})
				: undefined;
	if (!value) throw new Error(`Unsupported ZIP compression for ${entry.name}.`);
	if (value.byteLength !== entry.uncompressedBytes) {
		throw new Error(`Uncompressed size mismatch for ${entry.name}.`);
	}
	return value;
}

export function isSafeZipEntryName(name: string): boolean {
	if (
		name.length === 0 ||
		name.startsWith("/") ||
		name.startsWith("\\") ||
		name.includes("\\") ||
		name.includes("\0") ||
		/^[A-Za-z]:/u.test(name)
	) {
		return false;
	}
	return name.split("/").every((part, index, parts) => {
		if (part === ".." || part === ".") return false;
		return part.length > 0 || index === parts.length - 1;
	});
}

export async function readZipArchive(path: string): Promise<Buffer> {
	const file = await stat(path);
	if (!file.isFile()) throw new Error("The package path is not a regular file.");
	if (file.size > MAX_ZIP_ARCHIVE_BYTES) {
		throw new Error("The package exceeds the safe archive-size budget.");
	}
	const archive = await readFile(path);
	if (archive.byteLength > MAX_ZIP_ARCHIVE_BYTES) {
		throw new Error("The package grew beyond the safe archive-size budget while being read.");
	}
	return archive;
}

export async function extractZipArchive(
	archive: Buffer,
	entries: readonly ZipEntry[],
	destination: string,
): Promise<void> {
	if (archive.byteLength > MAX_ZIP_ARCHIVE_BYTES) {
		throw new Error("The package is too large to extract safely.");
	}
	if (entries.length > MAX_EXTRACTED_FILES) {
		throw new Error("The package contains too many entries to extract safely.");
	}
	const totalBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
	if (totalBytes > MAX_EXTRACTED_BYTES) {
		throw new Error("The package expands beyond the safe extraction budget.");
	}

	const names = new Set<string>();
	for (const entry of entries) {
		if (!isSafeZipEntryName(entry.name)) throw new Error(`Unsafe ZIP path: ${entry.name}`);
		if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
		names.add(entry.name);
		if ((entry.unixMode & 0o170000) === 0o120000) {
			throw new Error(`Symbolic links are not extracted: ${entry.name}`);
		}
	}

	for (const entry of entries) {
		const outputPath = resolve(destination, ...entry.name.split("/"));
		if (entry.name.endsWith("/")) {
			await mkdir(outputPath, { recursive: true });
			continue;
		}
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, readZipEntry(archive, entry), { flag: "wx" });
	}
}
