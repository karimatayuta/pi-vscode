import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
	extractZipArchive,
	isSafeZipEntryName,
	MAX_ZIP_ARCHIVE_BYTES,
	readZipArchive,
	readZipEntries,
	readZipEntry,
} from "../../scripts/zip-archive.js";

interface StoredEntry {
	readonly name: string;
	readonly content: string;
	readonly compression?: "deflate";
	readonly declaredUncompressedBytes?: number;
	readonly unixMode?: number;
}

function storedZip(entries: readonly StoredEntry[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const uncompressed = Buffer.from(entry.content, "utf8");
		const content = entry.compression === "deflate" ? deflateRawSync(uncompressed) : uncompressed;
		const compressionMethod = entry.compression === "deflate" ? 8 : 0;
		const declaredUncompressedBytes = entry.declaredUncompressedBytes ?? uncompressed.byteLength;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x0403_4b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(compressionMethod, 8);
		local.writeUInt32LE(content.byteLength, 18);
		local.writeUInt32LE(declaredUncompressedBytes, 22);
		local.writeUInt16LE(name.byteLength, 26);
		localParts.push(local, name, content);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x0201_4b50, 0);
		central.writeUInt16LE(0x0314, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(compressionMethod, 10);
		central.writeUInt32LE(content.byteLength, 20);
		central.writeUInt32LE(declaredUncompressedBytes, 24);
		central.writeUInt16LE(name.byteLength, 28);
		central.writeUInt32LE((((entry.unixMode ?? 0o100644) & 0xffff) << 16) >>> 0, 38);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.byteLength + name.byteLength + content.byteLength;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x0605_4b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.byteLength, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

describe("cross-platform ZIP extraction", () => {
	test("extracts a nested stored entry without an external unzip command", async () => {
		const destination = await mkdtemp(join(tmpdir(), "pi-vscode-zip-"));
		try {
			const archive = storedZip([{ name: "extension/docs/index.md", content: "Pi docs" }]);
			await extractZipArchive(archive, readZipEntries(archive), destination);
			expect(await readFile(join(destination, "extension/docs/index.md"), "utf8")).toBe("Pi docs");
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	});

	test("bounds deflate output before a false small size declaration can expand", () => {
		const archive = storedZip([
			{
				name: "extension/bomb.txt",
				content: "A".repeat(1024 * 1024),
				compression: "deflate",
				declaredUncompressedBytes: 32,
			},
		]);
		const [entry] = readZipEntries(archive);
		if (!entry) throw new Error("The bomb fixture did not contain an entry.");
		let failure: unknown;
		try {
			readZipEntry(archive, entry);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("Uncompressed size mismatch");
	});

	test("rejects an oversized sparse archive before reading it into memory", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "pi-vscode-zip-"));
		try {
			const archivePath = join(fixture, "oversized.vsix");
			await writeFile(archivePath, "");
			await truncate(archivePath, MAX_ZIP_ARCHIVE_BYTES + 1);
			await expect(readZipArchive(archivePath)).rejects.toThrow(/archive-size budget/u);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	test("rejects traversal, Windows path confusion, duplicates, and symbolic links", async () => {
		expect(isSafeZipEntryName("../escape.txt")).toBe(false);
		expect(isSafeZipEntryName("extension\\..\\escape.txt")).toBe(false);
		expect(isSafeZipEntryName("C:/escape.txt")).toBe(false);

		const destination = await mkdtemp(join(tmpdir(), "pi-vscode-zip-"));
		try {
			const mismatchedNameArchive = storedZip([
				{ name: "extension/central.txt", content: "payload" },
			]);
			const [mismatchedNameEntry] = readZipEntries(mismatchedNameArchive);
			if (!mismatchedNameEntry) throw new Error("The name fixture did not contain an entry.");
			expect(() =>
				readZipEntry(mismatchedNameArchive, {
					...mismatchedNameEntry,
					name: "extension/different.txt",
				}),
			).toThrow(/names differ/u);

			for (const archive of [
				storedZip([{ name: "../escape.txt", content: "escape" }]),
				storedZip([
					{ name: "extension/file.txt", content: "one" },
					{ name: "extension/file.txt", content: "two" },
				]),
				storedZip([{ name: "extension/link", content: "../../escape.txt", unixMode: 0o120777 }]),
			]) {
				await expect(
					extractZipArchive(archive, readZipEntries(archive), destination),
				).rejects.toThrow();
			}
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	});
});
