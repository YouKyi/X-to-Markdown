// esbuild is configured with `loader: { '.css': 'text' }`, so a CSS import
// yields the stylesheet as a string that gets injected into the shadow root.
// No separate CSS file ships, and therefore no web_accessible_resources entry.

declare module '*.css' {
  const content: string;
  export default content;
}
