/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
    return knex.schema.createTable('person', function(table) {
        table.string('player_id').notNullable().primary();
        table.string('name').notNullable();
        table.string('birthday').nullable();
        table.boolean('active').notNullable().defaultTo(true);
        table.boolean('is_npc').notNullable().defaultTo(false);
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
    return knex.schema.dropTable('person');
};
