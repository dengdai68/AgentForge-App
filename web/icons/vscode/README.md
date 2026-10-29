# 工作目录文件图标（vscode-icons 子集）

本目录内除本说明外的全部 `.svg` 文件与 `LICENSE` 文本均来自
[vscode-icons](https://github.com/vscode-icons/vscode-icons)（master 分支），
按其所附 MIT License 使用（Copyright The vscode-icons Contributors，见同目录 `LICENSE`）。

选取原则：通用文件类型与默认文件/文件夹图标；不使用 `_official` 等含第三方商标 logo 的变体；
未识别的扩展名一律回退 `default_file.svg` / `default_folder.svg`。

映射逻辑（文件名/扩展名 → 图标文件）在 `client/console-projections.mjs` 的
`workingDirectoryIcon`，属于纯展示投影，可在 `tests/client-projections.test.mjs` 中验证。
图标仅用于任务空间「工作目录」页签的树形结构，不影响其他页面。
