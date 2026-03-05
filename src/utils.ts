/**
 * Remove characters that are illegal in file names across operating systems.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Simple {{variable}} template interpolation.
 * Arrays are joined with ", ". Null/undefined become empty string.
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = context[key];
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
  // Strip lines that are markdown images with an empty URL (e.g. no TMDB key)
  return rendered
    .split("\n")
    .filter((line) => !/^!\[.*?\]\(\s*\)\s*$/.test(line))
    .join("\n");
}

/**
 * Serialize an object to YAML frontmatter string (without --- delimiters).
 * Handles strings, numbers, booleans, arrays, null/undefined.
 */
export function toFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatYamlValue(item)}`);
      }
    } else {
      lines.push(`${key}: ${formatYamlValue(value)}`);
    }
  }
  return lines.join("\n");
}

function formatYamlValue(value: unknown): string {
  if (typeof value === "string") {
    // Quote strings that contain special YAML characters
    if (
      value.includes(":") ||
      value.includes("#") ||
      value.includes('"') ||
      value.includes("'") ||
      value.includes("\n") ||
      value.startsWith("[") ||
      value.startsWith("{") ||
      value.startsWith("!") ||
      value.startsWith("*") ||
      value.startsWith("&") ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      value === ""
    ) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return `"${String(value)}"`;
}

/**
 * Parse YAML frontmatter from a note's content.
 * Returns the parsed key-value pairs and the body after the frontmatter.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, string> = {};

  for (const line of yamlStr.split("\n")) {
    // Skip array items and empty lines
    if (line.startsWith("  -") || line.trim() === "") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let val = line.substring(colonIdx + 1).trim();
    // Remove surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }

  return { frontmatter, body };
}
