/*
 * Multi-user support: give every user a role plus an optional map of
 * per-permission overrides, and record which user owns a status page.
 *
 * Existing installations have exactly one user, who was implicitly the
 * administrator, so `role` defaults to "admin". New users created through the
 * user management screen are given an explicit role by the application.
 */
exports.up = async function (knex) {
    await knex.schema.alterTable("user", function (table) {
        table.string("role", 20).notNullable().defaultTo("admin");
        table.text("permissions").defaultTo(null);
        table.string("display_name", 150).defaultTo(null);
        table.string("email", 255).defaultTo(null);
    });

    await knex.schema.alterTable("status_page", function (table) {
        table.integer("user_id").unsigned().references("id").inTable("user").onDelete("SET NULL").onUpdate("CASCADE");
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("user_id");
    });

    await knex.schema.alterTable("user", function (table) {
        table.dropColumn("role");
        table.dropColumn("permissions");
        table.dropColumn("display_name");
        table.dropColumn("email");
    });
};
