export namespace KnowledgeBroker {
  export type Provenance = {
    source: string
    confidence: "high" | "medium" | "low"
    kev?: boolean
    epss?: number
    fetchedAt: number
  }

  export type Advisory = {
    id: string
    title: string
    severity: string
    provenance: Provenance
    applicable: boolean
    reason: string
  }

  export function separatePossibilityFromApplicability(
    component: string,
    advisories: Advisory[]
  ): { possible: Advisory[]; applicable: Advisory[] } {
    const possible = advisories.filter((a) => !a.applicable)
    const applicable = advisories.filter((a) => a.applicable)
    return { possible, applicable }
  }

  export function enrichWithKEV(advisories: Advisory[]): Advisory[] {
    return advisories.map((a) => ({
      ...a,
      provenance: { ...a.provenance, kev: a.provenance.kev ?? false },
    }))
  }
}
