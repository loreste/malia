// JSX component in TSX
export function MyComponent(props: { name: string; count: number }) {
  return {
    tag: "div",
    props: {
      id: "root",
      children: [
        { tag: "h1", text: `Hello, ${props.name}!` },
        { tag: "span", text: `Count: ${props.count}` },
      ],
    },
  };
}

export function renderMock(element: any): string {
  if (typeof element === "string") return element;
  const children = (element.props?.children || []).map(renderMock).join("");
  const text = element.text || "";
  return `<${element.tag}>${text}${children}</${element.tag}>`;
}
