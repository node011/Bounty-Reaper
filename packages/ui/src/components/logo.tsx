import { ComponentProps } from "solid-js"

const BR_CELLS: [number, number][] = [
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 6], [0, 7], [0, 8], [0, 9],
  [1, 0], [1, 3], [1, 6], [1, 9],
  [2, 0], [2, 1], [2, 2], [2, 6], [2, 7], [2, 8],
  [3, 0], [3, 3], [3, 6], [3, 9],
  [4, 0], [4, 1], [4, 2], [4, 3], [4, 6], [4, 7], [4, 8], [4, 9],
]

// BountyReper "BR" mark — 10x5 grid rendered in a 512 viewBox
const BrCells = (props: { size?: number; fill?: string }) => {
  const size = props.size ?? 512
  const cols = 10
  const rows = 5
  const cell = size / cols
  const h = cell * rows
  const ox = (size - cols * cell) / 2
  const oy = (size - h) / 2
  return (
    <g fill={props.fill ?? "currentColor"}>
      {BR_CELLS.map(([r, c]) => (
        <rect x={ox + c * cell} y={oy + r * cell} width={cell} height={cell} />
      ))}
    </g>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <BrCells fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 400 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(0, -4) scale(0.2)">
        <BrCells fill="var(--icon-strong-base)" />
      </g>
      <text
        x="200"
        y="105"
        text-anchor="middle"
        font-family="'Space Grotesk Variable', system-ui, sans-serif"
        font-size="30"
        font-weight="700"
        letter-spacing="-0.5"
        fill="var(--icon-strong-base)"
      >
        BountyReper
      </text>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 160"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(0, 4) scale(0.2)">
        <BrCells fill="var(--icon-strong-base)" />
      </g>
      <text
        x="200"
        y="145"
        text-anchor="middle"
        font-family="'Space Grotesk Variable', system-ui, sans-serif"
        font-size="30"
        font-weight="700"
        letter-spacing="-0.5"
        fill="var(--icon-strong-base)"
      >
        BountyReper
      </text>
    </svg>
  )
}
