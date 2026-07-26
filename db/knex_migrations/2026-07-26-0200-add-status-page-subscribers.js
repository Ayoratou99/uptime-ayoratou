/*
 * Public email subscriptions for status pages.
 *
 * Subscribing is double opt-in: a row is created unconfirmed with a
 * confirmation token, and only becomes eligible for notifications once that
 * token is used. Every row also carries an unsubscribe token so each message
 * can offer one-click removal without the reader logging in anywhere.
 */
exports.up = async function (knex) {
    await knex.schema.alterTable("status_page", function (table) {
        table.boolean("subscription_enabled").notNullable().defaultTo(false);
    });

    await knex.schema.createTable("status_page_subscriber", function (table) {
        table.increments("id");
        table
            .integer("status_page_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("status_page")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.string("email", 255).notNullable();
        table.boolean("confirmed").notNullable().defaultTo(false);
        table.string("confirm_token", 64);
        table.string("unsubscribe_token", 64).notNullable();
        table.datetime("created_date").notNullable().defaultTo(knex.fn.now());
        table.datetime("confirmed_date");

        // One subscription per address per page; re-subscribing reuses the row.
        table.unique(["status_page_id", "email"], "status_page_subscriber_unique");
        table.index("unsubscribe_token", "status_page_subscriber_unsub");
        table.index("confirm_token", "status_page_subscriber_confirm");
    });
};

exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("status_page_subscriber");
    await knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("subscription_enabled");
    });
};
