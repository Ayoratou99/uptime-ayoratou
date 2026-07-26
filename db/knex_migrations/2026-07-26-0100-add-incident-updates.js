/*
 * Incident update timeline.
 *
 * Previously an incident held a single title/content pair, so posting a
 * follow-up meant overwriting what was there and losing the earlier text.
 * Each change is now appended as an `incident_update` row, and the incident
 * carries the current status of that timeline.
 */
exports.up = async function (knex) {
    await knex.schema.alterTable("incident", function (table) {
        table.string("status", 20).notNullable().defaultTo("investigating");
    });

    await knex.schema.createTable("incident_update", function (table) {
        table.increments("id");
        table
            .integer("incident_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("incident")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.string("status", 20).notNullable().defaultTo("investigating");
        table.text("content").notNullable();
        table.datetime("created_date").notNullable().defaultTo(knex.fn.now());
        table
            .integer("created_by")
            .unsigned()
            .references("id")
            .inTable("user")
            .onDelete("SET NULL")
            .onUpdate("CASCADE");

        table.index(["incident_id", "created_date"], "incident_update_incident_date");
    });

    // Give every existing incident a first timeline entry from its current
    // content, so pages that already have incidents render a history rather
    // than appearing empty.
    const incidents = await knex("incident").select("id", "content", "created_date", "active");
    for (const incident of incidents) {
        await knex("incident_update").insert({
            incident_id: incident.id,
            status: incident.active ? "investigating" : "resolved",
            content: incident.content ?? "",
            created_date: incident.created_date ?? knex.fn.now(),
        });
    }

    // Reflect the same reasoning on the incident itself.
    await knex("incident").where("active", false).update({ status: "resolved" });
};

exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("incident_update");
    await knex.schema.alterTable("incident", function (table) {
        table.dropColumn("status");
    });
};
