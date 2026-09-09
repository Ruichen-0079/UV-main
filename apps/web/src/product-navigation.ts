export type ProductView =
  | "home"
  | "models"
  | "people"
  | "memory"
  | "appearance"
  | "subtitle"
  | "behavior"
  | "vision"
  | "advanced"
  | "developer";

export const productDestinations: { id: ProductView; label: string; description: string; group: string }[] = [
  { id: "home", label: "Overview", description: "Your companion, at a glance.", group: "YUVI" },
  {
    id: "models",
    label: "AI & connections",
    description: "Connect a provider, add models, and choose how YUVI uses them.",
    group: "Personalize"
  },
  {
    id: "people",
    label: "People & voices",
    description: "Help YUVI recognize you and the people you know.",
    group: "Personalize"
  },
  {
    id: "memory",
    label: "Memory",
    description: "Choose how YUVI remembers your shared context.",
    group: "Personalize"
  },
  {
    id: "behavior",
    label: "Conversation",
    description: "Set the pace of proactive conversations.",
    group: "Personalize"
  },
  {
    id: "appearance",
    label: "Companion",
    description: "Choose your character and how they appear on your desktop.",
    group: "Desktop"
  },
  {
    id: "subtitle",
    label: "Subtitle",
    description: "Make spoken replies comfortable to read.",
    group: "Desktop"
  },
  {
    id: "vision",
    label: "Vision",
    description: "Check whether YUVI can understand your screen when needed.",
    group: "Desktop"
  },
  {
    id: "advanced",
    label: "System",
    description: "Language, local services, and connection troubleshooting.",
    group: "System"
  }
];

