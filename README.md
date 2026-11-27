# Greenflame

Greenflame 是一个浏览器扩展，可将微信读书中当前账号有权阅读的 EPUB 型书籍导出为 `.epub` 文件，包含章节、目录和可下载的插图。

## 安装与使用

1. 在项目目录运行 `pnpm install --frozen-lockfile`。开发环境使用 Node.js 24 或更新版本，pnpm 版本见 `package.json`。
2. 在 Dia 或 Chrome 打开扩展管理页，开启开发者模式，选择「加载已解压的扩展程序」，选中项目内的 `chrome-extension` 目录。使用 Chrome 110 或更新版本，Dia 使用支持 Manifest V3 的版本。
3. 在浏览器中登录微信读书并打开一本书，点击阅读页右下角的「导出本书」。按钮会显示进度，再次点击可取消。
4. 导出的文件会出现在浏览器下载记录中。网文 TXT 型书目暂不支持。图片下载失败时，EPUB 会保留图片占位。

扩展直接加载源码，无需构建。正文请求沿用浏览器中的微信读书会话，插图由扩展后台下载，EPUB 在浏览器内打包。导出前请确认有权保存相应内容。

开发时可用 `pnpm test` 运行 EPUB 导出模块的单元测试。

Greenflame 派生自 [WeRead Plus](https://github.com/EwenYoung/weread-plus)，遵循 [MIT 许可证](LICENSE)。
