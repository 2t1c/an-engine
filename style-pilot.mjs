// style-pilot.mjs: a style pilot tags each cover with the build it was written in (`styleArm`), so a
// readout can join on what shipped. No pilot is running: STYLE_ARMS is empty, and any styleArm on a
// spec is refused until one is declared here.

export const STYLE_ARMS = Object.freeze([]);

/** PURE. A spec's styleArm, checked: only a declared build, only on a cover. Empty list = pass. */
export function styleArmIssues(spec = {}) {
  const arm = spec.styleArm;
  if (arm == null || arm === '') return [];
  const out = [];
  if (!STYLE_ARMS.includes(arm)) out.push(`styleArm "${arm}" is not a declared build (${STYLE_ARMS.join(' | ') || 'none running'})`);
  if (spec.potOf || spec.harvestOf) out.push('styleArm is for covers: a pot or harvest ships its body verbatim, so no build applies');
  return out;
}

/** PURE. The X handle a donor URL belongs to, or null. */
export const donorHandle = (url) => (String(url || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i) || [])[1] || null;
