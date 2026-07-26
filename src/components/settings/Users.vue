<template>
    <div>
        <div v-if="settings.disableAuth" class="mt-5 d-flex align-items-center justify-content-center my-3">
            {{ $t("usersDisabledAuthMsg") }}
        </div>

        <div v-else>
            <div class="add-btn">
                <button class="btn btn-primary me-2" type="button" @click="openAdd">
                    <font-awesome-icon icon="plus" />
                    {{ $t("addUser") }}
                </button>
            </div>

            <span v-if="userList.length === 0" class="d-flex align-items-center justify-content-center my-3">
                {{ $t("noUsers") }}
            </span>

            <div v-for="user in userList" :key="user.id" class="item">
                <div class="left-part">
                    <div class="info">
                        <div class="title">
                            {{ user.displayName || user.username }}
                            <span class="badge ms-2" :class="roleBadgeClass(user.role)">
                                {{ $t("role_" + user.role) }}
                            </span>
                            <span v-if="!user.active" class="badge bg-secondary ms-1">{{ $t("Inactive") }}</span>
                            <span v-if="user.id === $root.userID" class="badge bg-info ms-1">{{ $t("you") }}</span>
                        </div>
                        <div class="status">
                            {{ user.username }}
                            <span v-if="user.email">&middot; {{ user.email }}</span>
                        </div>
                        <div class="date">{{ overrideSummary(user) }}</div>
                    </div>
                </div>

                <div class="buttons">
                    <div class="btn-group" role="group">
                        <button class="btn btn-normal" @click="openEdit(user)">
                            <font-awesome-icon icon="edit" />
                            {{ $t("Edit") }}
                        </button>
                        <button
                            class="btn btn-danger"
                            :disabled="user.id === $root.userID"
                            :title="user.id === $root.userID ? $t('cannotDeleteSelf') : ''"
                            @click="confirmDelete(user)"
                        >
                            <font-awesome-icon icon="trash" />
                            {{ $t("Delete") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Add / Edit dialog -->
        <div ref="userDialog" class="modal fade" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <form @submit.prevent="save">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ draft.id ? $t("editUser") : $t("addUser") }}</h5>
                            <button
                                type="button"
                                class="btn-close"
                                data-bs-dismiss="modal"
                                :aria-label="$t('Close')"
                            ></button>
                        </div>

                        <div class="modal-body">
                            <div class="row">
                                <div class="col-md-6 mb-3">
                                    <label for="user-username" class="form-label">{{ $t("Username") }}</label>
                                    <input
                                        id="user-username"
                                        v-model="draft.username"
                                        type="text"
                                        class="form-control"
                                        required
                                    />
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label for="user-displayname" class="form-label">{{ $t("displayName") }}</label>
                                    <input
                                        id="user-displayname"
                                        v-model="draft.displayName"
                                        type="text"
                                        class="form-control"
                                    />
                                </div>
                            </div>

                            <div class="row">
                                <div class="col-md-6 mb-3">
                                    <label for="user-email" class="form-label">{{ $t("Email") }}</label>
                                    <input id="user-email" v-model="draft.email" type="email" class="form-control" />
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label for="user-password" class="form-label">
                                        {{ draft.id ? $t("newPasswordOptional") : $t("Password") }}
                                    </label>
                                    <input
                                        id="user-password"
                                        v-model="draft.password"
                                        type="password"
                                        class="form-control"
                                        autocomplete="new-password"
                                        :required="!draft.id"
                                    />
                                </div>
                            </div>

                            <div class="mb-3">
                                <label for="user-role" class="form-label">{{ $t("Role") }}</label>
                                <select id="user-role" v-model="draft.role" class="form-select">
                                    <option v-for="role in roles" :key="role" :value="role">
                                        {{ $t("role_" + role) }}
                                    </option>
                                </select>
                                <div class="form-text">{{ roleDescription }}</div>
                            </div>

                            <div class="form-check form-switch mb-3">
                                <input
                                    id="user-active"
                                    v-model="draft.active"
                                    class="form-check-input"
                                    type="checkbox"
                                />
                                <label class="form-check-label" for="user-active">{{ $t("Active") }}</label>
                            </div>

                            <hr />

                            <h6>{{ $t("permissionOverrides") }}</h6>
                            <p class="form-text mt-0">
                                {{
                                    draft.role === "admin"
                                        ? $t("permissionOverridesAdminNote")
                                        : $t("permissionOverridesHelp")
                                }}
                            </p>

                            <div v-if="draft.role !== 'admin'" class="permission-grid">
                                <div v-for="group in groupedPermissions" :key="group.name" class="permission-group">
                                    <div class="permission-group-title">{{ $t("permGroup_" + group.name) }}</div>
                                    <div v-for="perm in group.items" :key="perm" class="permission-row">
                                        <select
                                            :id="'perm-' + perm"
                                            class="form-select form-select-sm perm-select"
                                            :value="overrideValue(perm)"
                                            @change="setOverride(perm, $event.target.value)"
                                        >
                                            <option value="inherit">
                                                {{ $t("permInherit") }} ({{ rolePreset(perm) ? $t("Yes") : $t("No") }})
                                            </option>
                                            <option value="true">{{ $t("permAllow") }}</option>
                                            <option value="false">{{ $t("permDeny") }}</option>
                                        </select>
                                        <label :for="'perm-' + perm" class="perm-label">{{ $t("perm_" + perm) }}</label>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                                {{ $t("Cancel") }}
                            </button>
                            <button type="submit" class="btn btn-primary" :disabled="processing">
                                {{ $t("Save") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <Confirm
            ref="confirmDeleteDialog"
            btn-style="btn-danger"
            :yes-text="$t('Yes')"
            :no-text="$t('No')"
            @yes="doDelete"
        >
            {{ $t("confirmDeleteUser") }}
        </Confirm>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import Confirm from "../Confirm.vue";

/**
 * Permission keys grouped for display. Mirrors PERMISSION_LIST in
 * server/permissions.js -- kept in the same order so the UI reads
 * the same way the model is defined.
 */
const PERMISSION_GROUPS = [
    {
        name: "monitors",
        items: [
            "monitor.view.all",
            "monitor.create",
            "monitor.edit.own",
            "monitor.edit.all",
            "monitor.delete.own",
            "monitor.delete.all",
        ],
    },
    {
        name: "statusPages",
        items: [
            "statuspage.view.all",
            "statuspage.create",
            "statuspage.edit.own",
            "statuspage.edit.all",
            "statuspage.delete.own",
            "statuspage.delete.all",
        ],
    },
    {
        name: "administration",
        items: ["maintenance.manage", "notification.manage", "settings.manage", "user.manage"],
    },
];

/** Permissions each non-admin role grants by default. Mirrors ROLE_PERMISSIONS. */
const ROLE_PRESETS = {
    editor: [
        "monitor.create",
        "monitor.edit.own",
        "monitor.delete.own",
        "statuspage.create",
        "statuspage.edit.own",
        "statuspage.delete.own",
        "maintenance.manage",
        "notification.manage",
    ],
    viewer: [],
};

export default {
    components: { Confirm },

    props: {
        settings: {
            type: Object,
            default: () => ({}),
        },
    },

    data() {
        return {
            modal: null,
            processing: false,
            pendingDeleteID: null,
            roles: ["admin", "editor", "viewer"],
            groupedPermissions: PERMISSION_GROUPS,
            draft: this.emptyDraft(),
        };
    },

    computed: {
        userList() {
            return this.$root.userList ?? [];
        },

        /**
         * Description of the role currently selected in the dialog.
         *
         * Resolved here rather than concatenated in the template so the
         * translation key checker can see each key literally.
         * @returns {string} Translated description.
         */
        roleDescription() {
            return {
                admin: this.$t("role_admin_desc"),
                editor: this.$t("role_editor_desc"),
                viewer: this.$t("role_viewer_desc"),
            }[this.draft.role];
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.userDialog);
        this.load();
    },

    methods: {
        /**
         * A blank user draft.
         * @returns {object} Draft object.
         */
        emptyDraft() {
            return {
                id: null,
                username: "",
                displayName: "",
                email: "",
                password: "",
                role: "editor",
                active: true,
                overrides: {},
            };
        },

        /**
         * Fetch the user list from the server.
         * @returns {void}
         */
        load() {
            this.$root.getSocket().emit("getUserList", (res) => {
                if (!res.ok) {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Open the dialog for a new user.
         * @returns {void}
         */
        openAdd() {
            this.draft = this.emptyDraft();
            this.modal.show();
        },

        /**
         * Open the dialog for an existing user.
         * @param {object} user User row.
         * @returns {void}
         */
        openEdit(user) {
            this.draft = {
                id: user.id,
                username: user.username,
                displayName: user.displayName ?? "",
                email: user.email ?? "",
                password: "",
                role: user.role,
                active: user.active,
                overrides: { ...(user.overrides ?? {}) },
            };
            this.modal.show();
        },

        /**
         * Current select value for a permission: "inherit", "true" or "false".
         * @param {string} perm Permission key.
         * @returns {string} Select value.
         */
        overrideValue(perm) {
            if (!(perm in this.draft.overrides)) {
                return "inherit";
            }
            return this.draft.overrides[perm] ? "true" : "false";
        },

        /**
         * Apply a change from the permission select.
         * @param {string} perm Permission key.
         * @param {string} value "inherit", "true" or "false".
         * @returns {void}
         */
        setOverride(perm, value) {
            if (value === "inherit") {
                delete this.draft.overrides[perm];
            } else {
                this.draft.overrides[perm] = value === "true";
            }
        },

        /**
         * Whether the draft's role grants a permission by default.
         * @param {string} perm Permission key.
         * @returns {boolean} True if the role includes it.
         */
        rolePreset(perm) {
            if (this.draft.role === "admin") {
                return true;
            }
            return (ROLE_PRESETS[this.draft.role] ?? []).includes(perm);
        },

        /**
         * One-line summary of a user's overrides for the list view.
         * @param {object} user User row.
         * @returns {string} Summary text.
         */
        overrideSummary(user) {
            const count = Object.keys(user.overrides ?? {}).length;
            if (user.role === "admin") {
                return this.$t("fullAccess");
            }
            return count === 0 ? this.$t("roleDefaults") : this.$t("nOverrides", { count });
        },

        /**
         * Bootstrap badge class for a role.
         * @param {string} role Role name.
         * @returns {string} CSS class.
         */
        roleBadgeClass(role) {
            return { admin: "bg-danger", editor: "bg-primary", viewer: "bg-secondary" }[role] ?? "bg-secondary";
        },

        /**
         * Persist the draft.
         * @returns {void}
         */
        save() {
            this.processing = true;
            const event = this.draft.id ? "editUser" : "addUser";

            this.$root.getSocket().emit(event, this.draft, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.modal.hide();
                }
            });
        },

        /**
         * Ask before deleting.
         * @param {object} user User row.
         * @returns {void}
         */
        confirmDelete(user) {
            this.pendingDeleteID = user.id;
            this.$refs.confirmDeleteDialog.show();
        },

        /**
         * Delete the pending user.
         * @returns {void}
         */
        doDelete() {
            this.$root.getSocket().emit("deleteUser", this.pendingDeleteID, (res) => {
                this.$root.toastRes(res);
                this.pendingDeleteID = null;
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.add-btn {
    margin-bottom: 20px;
}

.item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 10px;
    border-radius: 10px;
    transition: all ease-in-out 0.15s;

    &:hover {
        background-color: $highlight-white;
    }

    .dark &:hover {
        background-color: $dark-bg2;
    }

    .title {
        font-weight: bold;
        font-size: 18px;
    }

    .status,
    .date {
        font-size: 14px;
        color: $secondary-text;
    }
}

.permission-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 18px;
}

.permission-group-title {
    font-weight: bold;
    margin-bottom: 8px;
}

.permission-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
}

.perm-select {
    width: 145px;
    flex: 0 0 auto;
}

.perm-label {
    font-size: 14px;
    margin: 0;
}
</style>
