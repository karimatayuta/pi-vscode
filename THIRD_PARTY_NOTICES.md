# Third-Party Notices

Pi Agent for Visual Studio Code includes or adapts the following software. These notices do not alter the license of Pi Agent itself.

## Pi SDK

The shipped Pi runtime includes `@earendil-works/pi-agent-core` 0.84.3,
`@earendil-works/pi-ai` 0.84.3, `@earendil-works/pi-client` 0.84.3,
`@earendil-works/pi-coding-agent` 0.84.3, `@earendil-works/pi-protocol` 0.84.3,
`@earendil-works/pi-telemetry` 0.84.3, and `@earendil-works/pi-tui` 0.84.3.
These packages are distributed under the MIT License.

Copyright (c) 2025 Mario Zechner

The complete license is included at [`licenses/pi-MIT.txt`](licenses/pi-MIT.txt).

## AWS SDK for JavaScript

The shipped dependency graph includes `@aws-sdk/credential-provider-http` 3.972.72,
`@aws-sdk/credential-provider-login` 3.972.77, and `@aws-sdk/nested-clients`
3.997.44. These packages are distributed under the Apache License 2.0.

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

The complete license is included at
[`licenses/aws-sdk-Apache-2.0.txt`](licenses/aws-sdk-Apache-2.0.txt).

## data-uri-to-buffer

`data-uri-to-buffer` 4.0.1 is distributed under the MIT License.

Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>

The complete license is included at
[`licenses/data-uri-to-buffer-MIT.txt`](licenses/data-uri-to-buffer-MIT.txt).

## Markdown Preview Annotator

The Mermaid presentation, local-font, and SVG-ID isolation approach was adapted from [markdown-preview-annotator](https://github.com/karimatayuta/markdown-preview-annotator).

MIT License

Copyright (c) 2026 karimatayuta

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## beautiful-mermaid

`beautiful-mermaid` 1.1.3 is distributed under the MIT License.

Copyright (c) 2026 Craft Docs

The complete license is included at
[`licenses/beautiful-mermaid-MIT.txt`](licenses/beautiful-mermaid-MIT.txt).

## Bundled UI and rendering dependencies

The compiled Extension Host and Webview bundles also contain the following
libraries. Exact versions are recorded so the distributed bundle can be
reproduced and audited.

- `@preact/signals` 2.11.1 and `@preact/signals-core` 1.14.4 — MIT License.
  Copyright (c) 2022-present Preact Team. The complete license is included at
  [`licenses/preact-signals-MIT.txt`](licenses/preact-signals-MIT.txt).
- `preact` 10.29.8 — MIT License. Copyright (c) 2015-present Jason Miller. The
  complete license is included at [`licenses/preact-MIT.txt`](licenses/preact-MIT.txt).
- `dompurify` 3.4.14 — Apache License 2.0 (selected from the package's
  Apache-2.0-or-MPL-2.0 dual license). Copyright Mario Heiderich and DOMPurify
  contributors. The complete selected license is included at
  [`licenses/dompurify-Apache-2.0.txt`](licenses/dompurify-Apache-2.0.txt).
- `linkify-it` 6.1.0 — MIT License. Copyright (c) 2015 Vitaly Puzrin. The
  complete license is included at
  [`licenses/linkify-it-MIT.txt`](licenses/linkify-it-MIT.txt).
- `markdown-it` 15.0.0 — MIT License. Copyright (c) 2014 Vitaly Puzrin and
  Alex Kocharin. The complete license is included at
  [`licenses/markdown-it-MIT.txt`](licenses/markdown-it-MIT.txt).
- `mdurl` 2.1.0 — MIT License. Copyright (c) 2015 Vitaly Puzrin and Alex
  Kocharin; portions copyright Joyent, Inc. and other Node contributors. The
  complete license and both notices are included at
  [`licenses/mdurl-MIT.txt`](licenses/mdurl-MIT.txt).
- `punycode.js` 2.3.1 and `uc.micro` 3.0.0 — MIT License. Copyright Mathias
  Bynens. The complete license is included at
  [`licenses/punycode-uc-micro-MIT.txt`](licenses/punycode-uc-micro-MIT.txt).
- `valibot` 1.4.2 — MIT License. Copyright (c) Fabian Hiller. The complete
  license is included at [`licenses/valibot-MIT.txt`](licenses/valibot-MIT.txt).
- `entities` 7.0.1 and `entities` 8.0.0 — BSD 2-Clause License. The complete
  license is included at
  [`licenses/entities-BSD-2-Clause.txt`](licenses/entities-BSD-2-Clause.txt).
- `elkjs` 0.11.1 — Eclipse Public License 2.0. The complete license is included
  at [`licenses/elkjs-EPL-2.0.md`](licenses/elkjs-EPL-2.0.md). Corresponding
  source for the shipped version is available from the
  [`elkjs@0.11.1` npm package](https://www.npmjs.com/package/elkjs/v/0.11.1)
  and the [upstream repository](https://github.com/kieler/elkjs).

These local license copies are included in the VSIX package.
