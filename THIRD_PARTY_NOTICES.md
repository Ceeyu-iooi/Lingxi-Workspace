# Third-Party Notices

Personal Workbench Skills is distributed for non-commercial use under CC BY-NC 4.0. The dependencies below retain their own licenses. The original skill provenance is listed below; this application's added ZCode theme source is described in its separate notice at the end of this file.

## Design Generation

| Project | Pinned source | License | Use in this Skill |
|---|---|---|---|
| UI UX Pro Max | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/b0ebb1797ebc6467fcf3a35f96d768d15faf5120 | MIT | Workbench-focused BM25 search, design datasets, stack guidance, design dials, structured visual briefs, and generated design-system contracts |

## Quality Audits

| Project | Pinned source | License | Use in this Skill |
|---|---|---|---|
| Taste Skill | https://github.com/Leonxlnx/taste-skill/tree/e988add20dab0fa97d7a76781c48961c8184288e | MIT | Anti-generic visual review and expression, motion, and density checks only |
| HIG Doctor | https://github.com/raintree-technology/hig-doctor/tree/0fe0684f3d080c8572a8f9bc590b3e32ea378afb | MIT for tooling, structure, and Skill files | Optional accessibility and interaction audit; Apple HIG reference text is not redistributed |

User-provided screenshots, brands, repositories, and assets are evaluated only for the current generated project. Review their license terms before copying source or assets and carry applicable notices into that project.
# ZCode design and architecture reference

ZCode, Copyright its respective contributors, Apache License 2.0.
Source: https://github.com/zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
The Zai Light and Zai Dark variable blocks are copied into `static/zcode-tokens.css`.
The workstation adapters, commands and Python document store are new project code.
The upstream license and notice are retained in `static/vendor/zcode/`.

Tailwind CSS v4.1.13, MIT License: four palette dependencies used by the ZCode
variables are copied from the official theme. License: `static/vendor/tailwind/LICENSE`.

## Token accounting reference and optional decoder

The collector boundary research references [token-monitor](https://github.com/Javis603/token-monitor) (MIT) and [tokscale fork commit ab1067f3](https://github.com/Javis603/tokscale/tree/ab1067f38edda3faa822c67b6df016c5c38ded9b) (MIT). The Python implementation is maintained here; no tokscale executable is bundled. Harness decoding uses [python-zstandard 0.25.0](https://pypi.org/project/zstandard/0.25.0/) (BSD-3-Clause), installed separately; its package licenses remain with the distribution. Public daily prices come from [ModelRadar](https://modelradar.cn/api), whose source and limitations are preserved in the accounting reports.

## Desktop preview and React preparation (0.0.21)

Electron 44.5.1 and electron-builder 26.15.3 use their upstream licenses. The portable application includes Electron/Chromium notices and the project's CC BY-NC 4.0 license. The backend bundles Python 3.12.5, SQLite, OpenSSL, zstandard 0.25.0 (including its distribution license) using PyInstaller 6.22.3 and its bootloader exception. React 19.3.0 and the Vite/TypeScript/shadcn preparation dependencies are build-time tools; their original licenses remain in the installed packages.

React Bits Pro is a separate paid license, not CC BY-NC or MIT. The three requested blocks have not been obtained or integrated in this preview. The repository contains only public registry configuration and independently written host adapters. Any later licensed original files belong under ignored frontend/private; do not commit them to a public repository or expose them via workspace APIs. Refer to https://pro.reactbits.dev/license.

## DeepSeek Harness settings reference (0.0.22)

DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License. Reference commit: [5badb15009ae1756c3afe0ae0cef1faafc290ccc](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc). SettingsRoot, AppearanceRow, FontSizeRow and ModelsSection layout/style rules inform the scoped adaptation in static/dsh-settings.css and its native workbench markup. The upstream license is retained at static/vendor/dsh/LICENSE. No DSH runtime, credential store, provider protocol or account implementation is imported. This adaptation replaces the previous paid-block design target for settings and API Key management; it does not install or claim React Bits Pro components.

## Shared application UI and local libraries (0.0.23)

- [Prompt-Tools](https://github.com/jwangkun/Prompt-Tools/tree/7f691789184bf3a6026b26bc3da66a46c24b03b3), MIT. Folder/list/editor/preview presentation informs the native HTTP adapters; no Tauri application or unsafe HTML insertion is imported. License: `static/vendor/prompt-tools/LICENSE`.
- [Skills-Manager](https://github.com/jiweiyeah/Skills-Manager/tree/bc3c8bd68cfe9a58a80b7c3631a8ed531d950823), MIT. Skill identity/list/detail presentation is adapted for read-only, account-owned HTTP data; no installation, enablement or Tauri calls. License: `static/vendor/skills-manager/LICENSE`.
- [React Bits](https://github.com/DavidHDev/react-bits/tree/ca44b3f9), MIT with Commons Clause. Public registry originals JellyRadio-JS-CSS and LatticeLoader-JS-CSS are integrated through `frontend/workbench-ui.jsx`. License: `static/vendor/reactbits/LICENSE`. Originals remain in ignored `frontend/private`; production application bundles include them for application use. `ui-kit.html` is an internal application page, not a standalone component library for redistribution. These are not React Bits Pro blocks. Registry receipts/hashes: `tools/reactbits-sources.json`.
- [prompts.chat](https://github.com/f/prompts.chat), CC0-1.0 prompt data. Bundled starter templates retain repository/file/commit/license/digest; account copies are separate. License: `static/vendor/prompt-market/CC0.txt`.
- [LangGPT](https://github.com/langgptai/LangGPT), Apache-2.0. The Chinese-poet example retains attribution and exact commit. License: `static/vendor/prompt-market/APACHE-2.0.txt`.
- PyYAML 6.0.3, MIT; Pillow 12.3.0, HPND/Pillow license. Frozen-backend copies retain distribution licenses under `licenses/PyYAML` and `licenses/Pillow`; parsing uses safe YAML and normalized raster avatars.
- Marked 18.1.0 and DOMPurify 3.4.16, their upstream licenses; used for sanitized previews. Motion 12.43.0, MIT, supports the public React Bits adapter. Dependency license texts remain in the installed distributions.

The 0.0.21 paid-registry preparation above is historical. The current registry configuration selects public React Bits; it does not require or expose a Pro license key.

## Shared controls (0.0.24)

0.0.25 adds a reproducible application-only SlideCommit adaptation for persistent right/green enabled state, reverse pointer travel and corresponding Home/End keyboard controls. tools/adapt_reactbits.cjs checks the untouched upstream receipt before generating an ignored private derivative. The same React Bits license applies; this derivative is bundled only as part of the application. WakeSlider is also used as a disabled, controlled preparation progress indicator.

SlideCommit-JS-CSS, SquishSwitch-JS-CSS and WakeSlider-JS-CSS were obtained with shadcn from the public React Bits registry on 2026-10-06. They are actual upstream components, adapted through frontend/workbench-ui.jsx, not React Bits Pro blocks. The retained React Bits license at static/vendor/reactbits/LICENSE applies; application-internal examples are not a separately distributed component package. Exact installed source hashes are recorded in tools/reactbits-sources.json; originals remain in ignored frontend/private. Hugeicons React and Core Free Icons dependencies retain their upstream license texts in node_modules. Existing Electron/Chromium notices must accompany any later NSIS installer. No installer was built or published in this iteration.

## DeepSeek Harness installer and onboarding reference (0.0.31)

DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License. Native GDI+ rounded-control macros and button drawing from apps/desktop/installer/drawing.nsh and pages.nsh are adapted in desktop/installer-drawing.nsh. Installer layout and first-run spacing/transitions reference the upstream native installer and DesktopOnboarding. Source: https://github.com/deepseek-ai/deepseek-harness . License: static/vendor/dsh/LICENSE. Lingxi branding is original; no DSH credential, telemetry, update or account implementation is imported. See docs/UI_DESIGN.md.
