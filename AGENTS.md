# Greenflame

Greenflame 是微信读书的 EPUB 导出扩展。提交、注释和项目文档使用中文。提交信息使用 `type: 描述`。

扩展目录为 `chrome-extension/`，可直接在支持 Manifest V3 的浏览器中加载。阅读页入口为 `content.js`，通过 `chrome.runtime.getURL` 动态加载 `lib/epub-export.js`。导出模块通过工厂接收浏览器依赖，纯函数可在 Node.js 中调用。跨域图片通过 `background.js` 下载。调整图片来源时，检查 Manifest 的宿主权限是否覆盖 CDN 重定向链。

编码规范见 `CLEAN-CODE.md`。EPUB 导出测试使用 `pnpm test`。
