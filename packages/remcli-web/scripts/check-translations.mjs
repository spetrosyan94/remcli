import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const localesRoot = join(sourceRoot, "lib", "locales");
const baseLocaleId = "ru";
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function unwrapExpression(expression) {
    while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
    }
    return expression;
}

function sourceFile(filePath) {
    return sourceFileFromText(filePath, readFileSync(filePath, "utf8"));
}

function sourceFileFromText(filePath, sourceText) {
    return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
}

function propertyName(property) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null;
    const name = property.name;
    return name && (ts.isStringLiteral(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name)) ? name.text : null;
}

function expressionFromVariable(file, variableName) {
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName || !declaration.initializer) continue;
            return unwrapExpression(declaration.initializer);
        }
    }
    return null;
}

function objectLiteralFromVariable(file, variableName) {
    const expression = expressionFromVariable(file, variableName);
    return expression && ts.isObjectLiteralExpression(expression) ? expression : null;
}

function readLocale(localeId) {
    const filePath = join(localesRoot, `${localeId}.ts`);
    const file = sourceFile(filePath);
    const object = objectLiteralFromVariable(file, localeId === "zh-Hans" ? "zhHans" : localeId === "zh-Hant" ? "zhHant" : localeId);
    if (!object) throw new Error(`${filePath}: locale object was not found`);

    const values = new Map();
    for (const property of object.properties) {
        const key = propertyName(property);
        if (!key || !ts.isPropertyAssignment(property)) {
            throw new Error(`${filePath}: every locale entry must be a string property assignment`);
        }
        if (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
            throw new Error(`${filePath}: ${key} must have a literal string value`);
        }
        values.set(key, property.initializer.text);
    }
    return values;
}

function collectFiles(root, extensions) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const fullPath = join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath, extensions));
        } else if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
            files.push(fullPath);
        }
    }
    return files;
}

function placeholders(value) {
    return new Set([...value.matchAll(placeholderPattern)].map((match) => match[1]));
}

function sameSet(left, right) {
    return left.size === right.size && [...left].every((item) => right.has(item));
}

function getLiteralValue(expression) {
    return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}

function objectLiteralParameterKeys(expression) {
    const value = unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(value)) return null;

    const keys = new Set();
    for (const property of value.properties) {
        const key = propertyName(property);
        if (!key) return null;
        keys.add(key);
    }
    return keys;
}

function collectTranslationCallsFromFile(file) {
    const literals = new Set();
    const pluralPrefixes = new Set();
    const literalCalls = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length > 0) {
            const argument = getLiteralValue(node.arguments[0]);
            if (argument) {
                if (node.expression.text === "t") {
                    const position = file.getLineAndCharacterOfPosition(node.getStart(file));
                    literals.add(argument);
                    literalCalls.push({
                        key: argument,
                        filePath: file.fileName,
                        line: position.line + 1,
                        parameterKeys: node.arguments[1] ? objectLiteralParameterKeys(node.arguments[1]) : new Set(),
                    });
                }
                if (node.expression.text === "tPlural") pluralPrefixes.add(argument);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return { literals, pluralPrefixes, literalCalls };
}

function collectTranslationCalls(filePath) {
    return collectTranslationCallsFromFile(sourceFile(filePath));
}

export function collectTranslationCallsFromSource(sourceText, filePath = "<inline>") {
    return collectTranslationCallsFromFile(sourceFileFromText(filePath, sourceText));
}

function formatParameterNames(names) {
    return `{${[...names].sort().join(", ")}}`;
}

export function validateTranslationCallParameters(literalCalls, base) {
    const errors = [];
    for (const call of literalCalls) {
        const value = base.get(call.key);
        if (value === undefined) continue;

        const expected = placeholders(value);
        if (expected.size === 0) continue;
        if (call.parameterKeys === null) {
            errors.push(`${call.filePath}:${call.line}: t(\"${call.key}\") must use a literal parameter object matching ${formatParameterNames(expected)}`);
            continue;
        }
        if (sameSet(call.parameterKeys, expected)) continue;

        const missing = new Set([...expected].filter((name) => !call.parameterKeys.has(name)));
        const unexpected = new Set([...call.parameterKeys].filter((name) => !expected.has(name)));
        const details = [
            missing.size > 0 ? `missing ${formatParameterNames(missing)}` : null,
            unexpected.size > 0 ? `unexpected ${formatParameterNames(unexpected)}` : null,
        ].filter(Boolean).join(", ");
        errors.push(`${call.filePath}:${call.line}: t(\"${call.key}\") parameters must match ${formatParameterNames(expected)} (${details})`);
    }
    return errors;
}

function collectDynamicMapKeys(filePath, variableName, propertyNameToRead) {
    const keys = new Set();
    const file = sourceFile(filePath);
    const expression = expressionFromVariable(file, variableName);
    if (!expression) throw new Error(`${filePath}: ${variableName} was not found`);
    const visit = (node) => {
        if (ts.isPropertyAssignment(node) && propertyName(node) === propertyNameToRead) {
            const value = getLiteralValue(node.initializer);
            if (value) keys.add(value);
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    return keys;
}

function collectRecordValueKeys(filePath, variableName) {
    const keys = new Set();
    const file = sourceFile(filePath);
    const object = objectLiteralFromVariable(file, variableName);
    if (!object) throw new Error(`${filePath}: ${variableName} was not found`);
    for (const property of object.properties) {
        if (ts.isPropertyAssignment(property)) {
            const value = getLiteralValue(property.initializer);
            if (value) keys.add(value);
        }
    }
    return keys;
}

function getStringUnionMembers(file, typeName) {
    for (const statement of file.statements) {
        if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== typeName || !ts.isUnionTypeNode(statement.type)) continue;
        return new Set(statement.type.types.flatMap((member) => (
            ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []
        )));
    }
    throw new Error(`${file.fileName}: ${typeName} union was not found`);
}

function getObjectPropertyKeys(file, variableName) {
    const object = objectLiteralFromVariable(file, variableName);
    if (!object) throw new Error(`${file.fileName}: ${variableName} was not found`);
    return new Set(object.properties.map(propertyName).filter(Boolean));
}

function getLocalePickerIds(file) {
    const value = expressionFromVariable(file, "LOCALES");
    if (!value || !ts.isArrayLiteralExpression(value)) throw new Error(`${file.fileName}: LOCALES must be an array`);
    const ids = new Set();
    for (const element of value.elements) {
        if (!ts.isObjectLiteralExpression(element)) throw new Error(`${file.fileName}: invalid LOCALES entry`);
        const idProperty = element.properties.find((property) => propertyName(property) === "id");
        if (!idProperty || !ts.isPropertyAssignment(idProperty)) throw new Error(`${file.fileName}: LOCALES entry is missing id`);
        const id = getLiteralValue(idProperty.initializer);
        if (!id) throw new Error(`${file.fileName}: LOCALES id must be a literal`);
        ids.add(id);
    }
    return ids;
}

function report(errors) {
    for (const error of errors) console.error(`i18n check: ${error}`);
    process.exitCode = errors.length > 0 ? 1 : 0;
}

export function runTranslationCheck() {
    const errors = [];
    const registry = sourceFile(join(localesRoot, "index.ts"));
    const localeIds = getStringUnionMembers(registry, "LocaleId");
    const dictionaryIds = getObjectPropertyKeys(registry, "dictionaries");
    const pickerIds = getLocalePickerIds(registry);

    for (const [label, ids] of [["dictionaries", dictionaryIds], ["LOCALES", pickerIds]]) {
        if (!sameSet(localeIds, ids)) errors.push(`${label} must match LocaleId exactly`);
    }

    const localeFiles = new Set(readdirSync(localesRoot)
        .filter((file) => file.endsWith(".ts") && file !== "index.ts")
        .map((file) => basename(file, ".ts")));
    for (const localeId of localeIds) {
        if (!localeFiles.has(localeId)) errors.push(`missing locale file: ${localeId}.ts`);
    }

    const base = readLocale(baseLocaleId);
    for (const localeId of localeIds) {
        const dictionary = readLocale(localeId);
        for (const key of base.keys()) {
            if (!dictionary.has(key)) errors.push(`${localeId}: missing key ${key}`);
        }
        for (const key of dictionary.keys()) {
            if (!base.has(key)) errors.push(`${localeId}: unknown key ${key}`);
        }
        for (const [key, value] of dictionary) {
            if (value.trim().length === 0) errors.push(`${localeId}: empty value for ${key}`);
            const baseValue = base.get(key);
            if (baseValue !== undefined && !sameSet(placeholders(baseValue), placeholders(value))) {
                errors.push(`${localeId}: placeholders for ${key} must match ${baseLocaleId}`);
            }
        }
    }

    const literalKeys = new Set();
    const pluralPrefixes = new Set();
    const literalCalls = [];
    for (const filePath of collectFiles(sourceRoot, new Set([".ts", ".tsx"]))) {
        if (dirname(filePath) === localesRoot || filePath.startsWith(`${localesRoot}/`)) continue;
        const calls = collectTranslationCalls(filePath);
        calls.literals.forEach((key) => literalKeys.add(key));
        calls.pluralPrefixes.forEach((prefix) => pluralPrefixes.add(prefix));
        literalCalls.push(...calls.literalCalls);
    }
    for (const key of literalKeys) {
        if (!base.has(key)) errors.push(`literal t() key is missing from ${baseLocaleId}: ${key}`);
    }
    errors.push(...validateTranslationCallParameters(literalCalls, base));
    for (const prefix of pluralPrefixes) {
        if (!base.has(`${prefix}.other`)) errors.push(`tPlural() prefix is missing an .other key: ${prefix}`);
    }

    const dynamicKeys = [
        ...collectDynamicMapKeys(join(sourceRoot, "components", "app", "TabBar.tsx"), "TABS", "labelKey"),
        ...collectRecordValueKeys(join(sourceRoot, "components", "kit", "StatusBadge.tsx"), "STATUS_LABEL_KEY"),
        ...collectDynamicMapKeys(join(sourceRoot, "pages", "SettingsPage.tsx"), "THEME_OPTIONS", "labelKey"),
    ];
    for (const key of dynamicKeys) {
        if (!base.has(key)) errors.push(`dynamic translation key is missing from ${baseLocaleId}: ${key}`);
    }

    return {
        errors,
        summary: `i18n check: ${localeIds.size} locales, ${base.size} keys, ${literalKeys.size} literal calls and ${dynamicKeys.length} dynamic keys are valid`,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = runTranslationCheck();
    if (result.errors.length === 0) console.log(result.summary);
    report(result.errors);
}
