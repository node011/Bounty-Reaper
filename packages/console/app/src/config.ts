/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://bountyreper.io",

  // GitHub
  github: {
    repoUrl: "https://github.com/bounty-reper/BountyReper",
    starsFormatted: {
      compact: "100K",
      full: "100,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/bountyreper",
    discord: "https://discord.gg/snunAaHf6U",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "700",
    commits: "9,000",
    monthlyUsers: "2.5M",
  },
} as const
