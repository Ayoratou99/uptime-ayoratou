const Database = require("../database");
const { PERMISSIONS } = require("../permissions");
const { requirePermission } = require("../socket-permissions");

/**
 * Handlers for database
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.databaseSocketHandler = (socket) => {
    // Post or edit incident
    socket.on("getDatabaseSize", async (callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.SETTINGS_MANAGE);
            callback({
                ok: true,
                size: await Database.getSize(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("shrinkDatabase", async (callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.SETTINGS_MANAGE);
            await Database.shrink();
            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};
