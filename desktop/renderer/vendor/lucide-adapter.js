// Adapter for the official Lucide browser bundle.
// Keep icon names in kebab-case in the renderer and resolve them from Lucide's
// complete icon set instead of maintaining a hand-written SVG subset.
(() => {
  const pascalCase = (name) => String(name)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  window.RemoteWorkspaceIcons = {
    render(name) {
      const iconName = pascalCase(name);
      const icon = window.lucide?.icons?.[iconName] || window.lucide?.icons?.AlertCircle;
      if (!icon || !window.lucide?.createElement) return '';
      const svg = window.lucide.createElement(icon);
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      return svg.outerHTML;
    },
  };
})();
