/*
 * Automatic incidents for sustained downtime.
 *
 * When a monitor has been continuously down for `auto_incident_minutes`, an
 * incident is posted on every status page that publishes it, and resolved
 * automatically when the monitor recovers. Zero (the default) disables it, so
 * existing monitors are unaffected.
 *
 * `auto_incident_id` remembers the incident this monitor opened, so recovery
 * resolves that one rather than guessing.
 */
exports.up = async function (knex) {
    await knex.schema.alterTable("monitor", function (table) {
        table.integer("auto_incident_minutes").notNullable().defaultTo(0);
    });

    await knex.schema.alterTable("incident", function (table) {
        // Marks an incident as machine-created, so it can be resolved
        // automatically without touching ones an operator wrote by hand.
        table
            .integer("auto_monitor_id")
            .unsigned()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");

        table.index("auto_monitor_id", "incident_auto_monitor");
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("incident", function (table) {
        table.dropColumn("auto_monitor_id");
    });

    await knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("auto_incident_minutes");
    });
};
