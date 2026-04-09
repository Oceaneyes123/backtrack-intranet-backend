/**
 * Parses an ALLOWED_ORIGIN config string into either "*" or a string[].
 * @param {string} str
 * @returns {"*" | string[]}
 */
const parseOrigins = (str) => {
  if (str === "*") return "*";
  return String(str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

export { parseOrigins };
