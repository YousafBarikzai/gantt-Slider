// Per-type create permissions. Admins can do everything; guests nothing.
// Members can create every type by default, but an admin can switch specific
// types off for the member role (e.g. "members may raise risks but not decisions").
// Overrides are stored as a single JSON blob in app_config.
import { getConfig, setConfig } from './db.js';
import { TYPES, CATALOGUE } from './records.js';

const KEY = 'record_permissions';

export function getOverrides() {
    try {
        return JSON.parse(getConfig(KEY) || '{}');
    } catch {
        return {};
    }
}

export function setMemberOverrides(memberMap) {
    // Persist only explicit member entries; absence means "allowed".
    const member = {};
    for (const t of TYPES) {
        if (memberMap && memberMap[t] === false) member[t] = false;
    }
    setConfig(KEY, JSON.stringify(Object.keys(member).length ? { member } : {}));
}

// Can this user create records of `type`?
export function canCreateType(user, type) {
    if (!user || !CATALOGUE[type]) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'guest') return false;
    const roleOv = getOverrides()[user.role] || {};
    return roleOv[type] !== false; // members default to allowed
}

// Full role × type matrix for the admin editor.
export function effectiveMatrix() {
    const ov = getOverrides();
    const roles = ['admin', 'member', 'guest'];
    const matrix = {};
    for (const r of roles) {
        matrix[r] = {};
        for (const t of TYPES) {
            matrix[r][t] =
                r === 'admin' ? true : r === 'guest' ? false : (ov.member || {})[t] !== false;
        }
    }
    return {
        roles,
        types: TYPES.map((t) => ({ type: t, label: CATALOGUE[t].label })),
        matrix,
    };
}
