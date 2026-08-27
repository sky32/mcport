# Renderer 国际化约定

Desktop Renderer 的界面文案必须使用 key 驱动的翻译入口，不能依赖 DOM 扫描猜测语言。

## 编码规则

- 固定界面文案使用 `data-i18n="key"` 和 `desktop/renderer/i18n.js` 中的 `keyed` 词条。
- 动态文案使用 `t('key', { name, count })`；如果暂时需要传入已有中文源文本，必须使用 `localizedText()` 或 `localizedMultiline()`。
- Toast、confirm、`textContent`、`title`、`aria-label`、`placeholder` 和 `data-help` 同样属于界面文案，不能直接新增中文字符串。
- 不要新增 `MutationObserver` 做翻译。动态区域渲染完成后显式调用 `i18n.apply(document)`，或者在创建节点时直接使用 `t()`。
- 业务错误、Workspace 名称、路径、URL、Tool 名称等变量不能作为翻译 key；应放进参数模板中。
- 新增或修改文案时，中文和英文必须同时加入翻译目录，并在中英文界面各验证一次。

## 提交前检查

运行：

```bash
npm run check:renderer-i18n
```

该检查会验证静态 HTML 文本和属性是否存在翻译目录映射，并阻止重新引入 DOM 观察器翻译循环。桌面 UI 修改还必须运行 `npm run typecheck:desktop` 和 `npm run smoke:desktop:settings`。

AI 修改 Renderer 时应先阅读本文；如果发现已有代码仍使用旧的中文源文本，应在同一改动中迁移到 key 或统一本地化入口，不要复制旧模式。
