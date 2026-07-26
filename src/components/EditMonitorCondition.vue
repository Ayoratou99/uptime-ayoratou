<template>
    <div class="monitor-condition" data-testid="condition">
        <!-- and/or joiner, shown between conditions rather than before the first -->
        <select
            v-if="!isFirst"
            v-model="model.andOr"
            class="form-select and-or-select"
            :aria-label="$t('conditionJoin')"
            data-testid="condition-and-or"
        >
            <option value="and">{{ $t("and") }}</option>
            <option value="or">{{ $t("or") }}</option>
        </select>
        <span v-else class="and-or-placeholder">{{ $t("conditionWhen") }}</span>

        <div class="condition-fields">
            <select
                v-model="model.variable"
                class="form-select variable-select"
                :aria-label="$t('conditionVariable')"
                data-testid="condition-variable"
                @change="onVariableChange"
            >
                <option v-for="variable in conditionVariables" :key="variable.id" :value="variable.id">
                    {{ $t(variable.id) }}
                </option>
            </select>

            <select
                v-model="model.operator"
                class="form-select operator-select"
                :aria-label="$t('conditionOperator')"
                data-testid="condition-operator"
            >
                <option v-for="operator in operators" :key="operator.id" :value="operator.id">
                    {{ $t(operator.caption) }}
                </option>
            </select>

            <!-- Booleans get a proper choice instead of a free text box -->
            <select
                v-if="valueKind === 'boolean'"
                v-model="model.value"
                class="form-select value-input"
                :aria-label="$t('conditionValuePlaceholder')"
                data-testid="condition-value"
                required
            >
                <option value="true">{{ $t("Yes") }}</option>
                <option value="false">{{ $t("No") }}</option>
            </select>

            <input
                v-else
                v-model="model.value"
                :type="valueKind === 'number' ? 'number' : 'text'"
                class="form-control value-input"
                :placeholder="valuePlaceholder"
                :aria-label="$t('conditionValuePlaceholder')"
                data-testid="condition-value"
                required
            />
        </div>

        <button
            v-if="!isInGroup || !isFirst || !isLast"
            class="btn btn-outline-danger remove-button"
            type="button"
            :aria-label="$t('conditionDelete')"
            :title="$t('conditionDelete')"
            data-testid="remove-condition"
            @click="remove"
        >
            <font-awesome-icon icon="trash" />
        </button>
    </div>
</template>

<script>
/** Operator ids that imply the value is numeric. */
const NUMERIC_OPERATORS = ["num_equals", "num_not_equals", "lt", "gt", "lte", "gte"];

/**
 * Variables whose value is a yes/no choice rather than free text.
 * Keyed by variable id so new boolean variables only need adding here.
 */
const BOOLEAN_VARIABLES = ["body_is_json"];

/** Example value shown as a placeholder, per variable. */
const PLACEHOLDERS = {
    status_code: "200",
    response_time: "500",
    body_size: "1024",
    content_type: "application/json",
    body: "text to look for",
    record: "192.0.2.1",
};

export default {
    name: "EditMonitorCondition",

    props: {
        /**
         * The monitor condition
         */
        modelValue: {
            type: Object,
            required: true,
        },

        /**
         * Whether this is the first condition
         */
        isFirst: {
            type: Boolean,
            required: true,
        },

        /**
         * Whether this is the last condition
         */
        isLast: {
            type: Boolean,
            required: true,
        },

        /**
         * Whether this condition is in a group
         */
        isInGroup: {
            type: Boolean,
            required: false,
            default: false,
        },

        /**
         * Variable choices
         */
        conditionVariables: {
            type: Array,
            required: true,
        },
    },

    emits: ["update:modelValue", "remove"],

    computed: {
        model: {
            get() {
                return this.modelValue;
            },
            set(value) {
                this.$emit("update:modelValue", value);
            },
        },

        /**
         * Operators available for the selected variable.
         * @returns {object[]} Operator descriptors.
         */
        operators() {
            return this.getVariableOperators(this.model.variable);
        },

        /**
         * What kind of input the value field should be, derived from the
         * variable and its operators rather than hard-coded per monitor type.
         * @returns {string} "boolean", "number" or "text".
         */
        valueKind() {
            if (BOOLEAN_VARIABLES.includes(this.model.variable)) {
                return "boolean";
            }
            // A regex is text even on an otherwise numeric variable.
            if (this.model.operator === "regex" || this.model.operator === "not_regex") {
                return "text";
            }
            if (NUMERIC_OPERATORS.includes(this.model.operator)) {
                return "number";
            }
            return "text";
        },

        /**
         * Example value for the selected variable, so the expected format is
         * obvious without consulting documentation.
         * @returns {string} Placeholder text.
         */
        valuePlaceholder() {
            if (this.model.operator === "regex" || this.model.operator === "not_regex") {
                return this.$t("conditionRegexPlaceholder");
            }
            return PLACEHOLDERS[this.model.variable] ?? this.$t("conditionValuePlaceholder");
        },
    },

    methods: {
        remove() {
            this.$emit("remove", this.model);
        },

        /**
         * Keep the condition coherent when the variable changes: the previous
         * operator may not apply to the new variable, and a value carried over
         * from a text field would be meaningless in a boolean one.
         * @returns {void}
         */
        onVariableChange() {
            const available = this.operators;
            if (!available.some((operator) => operator.id === this.model.operator)) {
                this.model.operator = available[0]?.id ?? null;
            }

            if (this.valueKind === "boolean" && !["true", "false"].includes(this.model.value)) {
                this.model.value = "true";
            }
        },

        getVariableOperators(variableId) {
            return this.conditionVariables.find((v) => v.id === variableId)?.operators ?? [];
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.monitor-condition {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 10px;
}

// Keeps the three dropdowns aligned across rows while still wrapping on
// narrow screens instead of overflowing.
.condition-fields {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 8px;
    min-width: 0;
}

.and-or-select,
.and-or-placeholder {
    flex: 0 0 82px;
    width: 82px;
}

// Aligns the leading word of the first row with the joiner dropdowns below it.
.and-or-placeholder {
    display: flex;
    align-items: center;
    height: 38px;
    font-size: 14px;
    color: $secondary-text;
    padding-left: 2px;
}

.remove-button {
    flex: 0 0 auto;
    height: 38px;
}

@media (max-width: 700px) {
    .monitor-condition {
        flex-wrap: wrap;
    }

    .condition-fields {
        grid-template-columns: 1fr;
        flex-basis: 100%;
        order: 2;
    }

    .remove-button {
        order: 1;
        margin-left: auto;
    }
}
</style>
