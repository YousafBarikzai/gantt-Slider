// Single choke-point for writing audit-log entries.
import { db } from './db.js';

const insert = db.prepare(`
    INSERT INTO audit_log
        (user_id, user_name, entity_type, entity_id, entity_name,
         action, field, old_value, new_value, summary)
    VALUES
        (@user_id, @user_name, @entity_type, @entity_id, @entity_name,
         @action, @field, @old_value, @new_value, @summary)
`);

export function log(user, entry) {
    insert.run({
        user_id: user?.id ?? null,
        user_name: user?.name ?? 'System',
        entity_type: entry.entity_type,
        entity_id: entry.entity_id != null ? String(entry.entity_id) : null,
        entity_name: entry.entity_name ?? null,
        action: entry.action,
        field: entry.field ?? null,
        old_value: entry.old_value != null ? String(entry.old_value) : null,
        new_value: entry.new_value != null ? String(entry.new_value) : null,
        summary: entry.summary,
    });
}

// Diff two task objects and log one row per changed, human-meaningful field.
const TRACKED = {
    name: 'name',
    description: 'description',
    status: 'status',
    priority: 'priority',
    assignee_name: 'assignee',
    start: 'start date',
    end: 'end date',
    progress: 'progress',
    dependencies: 'dependencies',
};

export function logTaskChanges(user, before, after) {
    for (const key of Object.keys(TRACKED)) {
        const oldVal = before[key];
        const newVal = after[key];
        if (String(oldVal ?? '') === String(newVal ?? '')) continue;
        const label = TRACKED[key];
        log(user, {
            entity_type: 'task',
            entity_id: after.id,
            entity_name: after.name,
            action: 'update',
            field: label,
            old_value: oldVal,
            new_value: newVal,
            summary: `${user?.name ?? 'Someone'} changed ${label} of "${after.name}" from "${oldVal ?? '—'}" to "${newVal ?? '—'}"`,
        });
    }
}
