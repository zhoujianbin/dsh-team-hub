// Pure state transitions for the administrator's two-column workspace sharing picker.
// Kept free of DOM access so the selection rules can be tested directly in Node.

export function createShareState(users, owner, granted = []) {
  const candidates = (Array.isArray(users) ? users : [])
    .filter(user => user && typeof user.name === "string" && user.name && user.name !== owner)
    .map(user => ({ name: user.name, displayName: user.displayName || user.name }));
  const known = new Set(candidates.map(user => user.name));
  const grantedNames = new Set((Array.isArray(granted) ? granted : []).filter(name => known.has(name)));
  return {
    candidates,
    granted: candidates.filter(user => grantedNames.has(user.name)).map(user => user.name),
    available: candidates.filter(user => !grantedNames.has(user.name)).map(user => user.name)
  };
}

export function moveShareMembers(state, direction, names) {
  const grant = direction === "grant";
  const source = new Set(grant ? state.available : state.granted);
  const moving = new Set((Array.isArray(names) ? names : []).filter(name => source.has(name)));
  if (!moving.size) return state;
  const wasGranted = new Set(state.granted);
  return {
    candidates: state.candidates,
    granted: state.candidates.filter(user => moving.has(user.name) ? grant : wasGranted.has(user.name))
      .map(user => user.name),
    available: state.candidates.filter(user => moving.has(user.name) ? !grant : !wasGranted.has(user.name))
      .map(user => user.name)
  };
}
