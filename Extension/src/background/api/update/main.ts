/**
 * @file
 * This file is part of AdGuard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * AdGuard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard Browser Extension. If not, see <http://www.gnu.org/licenses/>.
 */
import zod from 'zod';
import isString from 'lodash-es/isString';
import isUndefined from 'lodash-es/isUndefined';

import { logger } from '../../../common/logger';
import { getErrorMessage } from '../../../common/error';
import {
    RAW_FILTER_KEY_PREFIX,
    FILTER_KEY_PREFIX,
    FiltersStorage,
    SbCache,
    hybridStorage,
    browserStorage,
    RawFiltersStorage,
} from '../../storages';
import {
    ADGUARD_SETTINGS_KEY,
    APP_VERSION_KEY,
    CLIENT_ID_KEY,
    NEWLINE_CHAR_REGEX,
    SCHEMA_VERSION_KEY,
} from '../../../common/constants';
import {
    type SafebrowsingCacheData,
    type SafebrowsingStorageData,
    SchemaPreprocessor,
    SettingOption,
} from '../../schema';
import type { RunInfo } from '../../utils/run-info';
import { IDBUtils } from '../../utils/indexed-db';
import { defaultSettings } from '../../../common/settings';
import { InstallApi } from '../install';

/**
 * Update API is a facade for handling migrations for the settings object from
 * browser.storage, to make sure that the application runs on the latest schema.
 */
export class UpdateApi {
    private static readonly schemaMigrationMap: Record<string, () => Promise<void>> = {
        '0': UpdateApi.migrateFromV0toV1,
        '1': UpdateApi.migrateFromV1toV2,
        '2': UpdateApi.migrateFromV2toV3,
        '3': UpdateApi.migrateFromV3toV4,
    };

    /**
     * Runs app updates depends on previous and current data schema.
     *
     * @param runInfo Info about extension start up.
     * @param runInfo.clientId Client id.
     * @param runInfo.currentAppVersion Current extension version.
     * @param runInfo.currentSchemaVersion Current data schema version.
     * @param runInfo.previousSchemaVersion Previous data schema version.
     */
    public static async update({
        clientId,
        currentAppVersion,
        currentSchemaVersion,
        previousSchemaVersion,
    }: RunInfo): Promise<void> {
        // check clientId existence
        if (clientId) {
            await browserStorage.set(CLIENT_ID_KEY, clientId);
        } else {
            await browserStorage.set(CLIENT_ID_KEY, InstallApi.genClientId());
        }

        // set actual schema and app version
        await browserStorage.set(SCHEMA_VERSION_KEY, currentSchemaVersion);
        await browserStorage.set(APP_VERSION_KEY, currentAppVersion);

        // run migrations, if they needed.
        await UpdateApi.runMigrations(currentSchemaVersion, previousSchemaVersion);
    }

    /**
     * Checks previousSchemaVersion and if it is outdated - runs migrations.
     *
     * @param currentSchemaVersion Current data schema version.
     * @param previousSchemaVersion Previous data schema version.
     */
    private static async runMigrations(
        currentSchemaVersion: number,
        previousSchemaVersion: number,
    ): Promise<void> {
        try {
            // if schema version changes, process migration
            for (let schema = previousSchemaVersion; schema < currentSchemaVersion; schema += 1) {
                const schemaMigrationAction = UpdateApi.schemaMigrationMap[schema];

                if (!schemaMigrationAction) {
                    // eslint-disable-next-line max-len
                    throw new Error(`Cannot find schema migration action from ${previousSchemaVersion} to ${currentSchemaVersion}.`);
                }

                // eslint-disable-next-line no-await-in-loop
                await UpdateApi.runSchemaMigration(schemaMigrationAction, schema, schema + 1);
            }
        } catch (e) {
            logger.error('Error while migrate: ', e);
            logger.info('Reset settings...');
            await browserStorage.set(ADGUARD_SETTINGS_KEY, defaultSettings);
        }
    }

    /**
     * Runs schema migration.
     *
     * @param schemaMigrationAction Schema migration action.
     * @param previousSchemaVersion Previous data schema version.
     * @param currentSchemaVersion Current data schema version.
     */
    private static async runSchemaMigration(
        schemaMigrationAction: () => Promise<void>,
        previousSchemaVersion: number,
        currentSchemaVersion: number,
    ): Promise<void> {
        try {
            await schemaMigrationAction();
        } catch (e: unknown) {
            // eslint-disable-next-line max-len
            const errMessage = `Error while schema migrating from ${previousSchemaVersion} to ${currentSchemaVersion}: ${getErrorMessage(e)}`;
            logger.error(errMessage);

            throw new Error(errMessage, { cause: e });
        }
    }

    /**
     * Run data migration from schema v3 to schema v4.
     *
     * @throws If previous data schema is invalid or saving data to the hybrid storage fails.
     */
    private static async migrateFromV3toV4(): Promise<void> {
        // Get all entries from the `browser.storage.local`.
        const entries = await browserStorage.entries();

        // Find all keys that are related to filters.
        const keys = Object.keys(entries);
        const rawFilterKeys = keys.filter((key) => key.startsWith(RAW_FILTER_KEY_PREFIX));
        const filterKeys = keys.filter((key) => key.startsWith(FILTER_KEY_PREFIX));

        // Check if there are no filters to migrate.
        if (rawFilterKeys.length === 0 && filterKeys.length === 0) {
            logger.debug('No filters to migrate from storage to hybrid storage');
            return;
        }

        // Prepare data to migrate.
        const migrationData: Record<string, string> = {};

        const filterSchema = zod.union([
            zod.string(),
            zod.array(zod.string()),
        ]);

        // Migrate filters.
        filterKeys.forEach((key) => {
            const filterId = FiltersStorage.extractFilterIdFromFilterKey(key);
            if (filterId === null) {
                logger.debug(`Failed to extract filter ID from the key: ${key}, skipping`);
                return;
            }

            const filterParsingResult = filterSchema.safeParse(entries[key]);

            if (!filterParsingResult.success) {
                logger.debug(
                    // eslint-disable-next-line max-len
                    `Failed to parse data from filter ID ${filterId} from the old storage: ${getErrorMessage(filterParsingResult.error)}`,
                );
                return;
            }

            const lines = Array.isArray(filterParsingResult.data)
                ? filterParsingResult.data
                : filterParsingResult.data.split(NEWLINE_CHAR_REGEX);

            Object.assign(migrationData, FiltersStorage.prepareFilterForStorage(filterId, lines));
        });

        // Migrate raw filters.
        rawFilterKeys.forEach((key) => {
            const filterId = RawFiltersStorage.extractFilterIdFromFilterKey(key);
            if (filterId === null) {
                logger.debug(`Failed to extract raw filter ID from the key: ${key}, skipping`);
                return;
            }

            const filterParsingResult = zod.string().safeParse(entries[key]);

            if (!filterParsingResult.success) {
                logger.debug(
                    // eslint-disable-next-line max-len
                    `Failed to parse data from raw filter ID ${filterId} from the old storage: ${getErrorMessage(filterParsingResult.error)}`,
                );
                return;
            }

            migrationData[key] = filterParsingResult.data;
        });

        // Save migrated data to the hybrid storage with a single transaction.
        const transactionResult = await hybridStorage.setMultiple(migrationData);
        if (!transactionResult) {
            throw new Error('Failed to migrate filters from storage to hybrid storage, transaction failed');
        }

        // Delete filters from the `browser.storage.local` after successful migration.
        await browserStorage.removeMultiple([...rawFilterKeys, ...filterKeys]);

        logger.debug('Filters successfully migrated from storage to hybrid storage');

        // We use passthrough to keep all other data as is, in this case we only need to update check times.
        const filterVersionDataValidatorV3 = zod.object({
            lastCheckTime: zod.number(),
            lastScheduledCheckTime: zod.number().optional(),
        }).passthrough();

        const filtersVersionDataValidatorV3 = zod.record(
            SchemaPreprocessor.numberValidator,
            filterVersionDataValidatorV3,
        );

        const storageData = await browserStorage.get(ADGUARD_SETTINGS_KEY);
        const settings = zod.record(zod.unknown()).parse(storageData);
        const rawFiltersVersion = settings[SettingOption.FiltersVersion];

        if (isString(rawFiltersVersion)) {
            const filtersVersionParsed = filtersVersionDataValidatorV3.safeParse(JSON.parse(rawFiltersVersion));

            if (filtersVersionParsed.success) {
                const filtersVersion = filtersVersionParsed.data;

                Object.values(filtersVersion).forEach((filterData) => {
                    if (isUndefined(filterData.lastScheduledCheckTime)) {
                        filterData.lastScheduledCheckTime = filterData.lastCheckTime;
                    }
                });

                settings[SettingOption.FiltersVersion] = JSON.stringify(filtersVersion);

                await browserStorage.set(ADGUARD_SETTINGS_KEY, settings);

                logger.debug('Filters version data successfully migrated from the old storage');
            } else {
                logger.debug(
                    // eslint-disable-next-line max-len
                    `Failed to parse filters version data from the old storage: ${getErrorMessage(filtersVersionParsed.error)}`,
                );
            }
        } else {
            logger.debug('Filters version data is not a string, skipping migration');
        }
    }

    /**
     * Run data migration from schema v2 to schema v3.
     */
    private static async migrateFromV2toV3(): Promise<void> {
        /**
         * From v4.2.144 we don't store filter rules in indexed DB, die to bug
         * https://bugzilla.mozilla.org/show_bug.cgi?id=1841806.
         */

        let db: IDBDatabase | null = null;

        try {
            db = await IDBUtils.connect('AdguardRulesStorage');
            const data = await IDBUtils.getAll(db, 'AdguardRulesStorage');

            const lists = zod
                .object({
                    key: zod.string(),
                    value: zod.string(),
                })
                .array()
                .parse(data);

            const results = await Promise.allSettled(
                lists.map(async ({ key, value }) => browserStorage.set(key, value.split(/\r?\n/))),
            );

            results.forEach((result) => {
                if (result.status === 'rejected') {
                    logger.info(getErrorMessage(result.reason));
                }
            });
        } catch (e: unknown) {
            logger.info('Error while migrate user rules', getErrorMessage(e));
        } finally {
            if (db) {
                db.close();
            }
        }

        /**
         * Add missed trusted flags for custom filters.
         */
        const storageData = await browserStorage.get('adguard-settings');
        const settings = zod.record(zod.unknown()).parse(storageData);
        const customFilters = settings['custom-filters'];

        if (typeof customFilters === 'string') {
            const customFiltersDataTransformer = zod
                .object({
                    trusted: zod.boolean().optional(),
                })
                .passthrough()
                .transform(({ trusted, ...rest }) => ({
                    ...rest,
                    trusted: Boolean(trusted),
                }))
                .array();

            const customFiltersData = JSON.parse(customFilters);
            settings['custom-filters'] = JSON.stringify(customFiltersDataTransformer.parse(customFiltersData));

            await browserStorage.set('adguard-settings', settings);
        }
    }

    /**
     * Run data migration from schema v1 to schema v2.
     */
    private static async migrateFromV1toV2(): Promise<void> {
        // From v4.2.135 we store timestamp of expiration time for safebrowsing cache records.
        const storageData = await browserStorage.get('sb-lru-cache');

        if (typeof storageData !== 'string') {
            return;
        }

        // parse v1 safebrowsing cache data
        const sbStorageDataV1 = zod
            .object({
                key: zod.string(),
                value: zod.string(),
            })
            .strict()
            .array()
            .parse(JSON.parse(storageData));

        const now = Date.now();

        // transform v1 safebrowsing storage data to v2
        const sbStorageDataV2: SafebrowsingStorageData = sbStorageDataV1.map(({ key, value }) => {
            const safebrowsingCacheRecord: SafebrowsingCacheData = { list: value };

            if (safebrowsingCacheRecord.list !== 'allowlist') {
                safebrowsingCacheRecord.expires = now + SbCache.CACHE_TTL_MS;
            }

            return {
                key,
                value: safebrowsingCacheRecord,
            };
        });

        await browserStorage.set('sb-lru-cache', JSON.stringify(sbStorageDataV2));
    }

    /**
     * Run data migration from schema v0 to schema v1.
     */
    private static async migrateFromV0toV1(): Promise<void> {
        // In the v4.0.171 we have littered window.localStorage with proms used in the promo notifications module,
        // now we are clearing them

        window.localStorage.removeItem('viewed-notifications');
        window.localStorage.removeItem('viewed-notification-time');

        // In the v4.2.0 we are refactoring storage data structure

        // get current settings
        const storageData = await browserStorage.get('adguard-settings');

        // check if current settings is record
        const currentSettings = zod
            .record(zod.unknown())
            .parse(storageData);

        // delete app version from settings
        if (currentSettings['app-version']) {
            delete currentSettings['app-version'];
        }

        // delete metadata from settings (new one will be loaded while filter initialization)
        if (currentSettings['filters-i18n-metadata']) {
            delete currentSettings['filters-i18n-metadata'];
        }

        if (currentSettings['filters-metadata']) {
            delete currentSettings['filters-metadata'];
        }

        // TODO: use zod preprocessors instead direct remapping and data transformation

        // rename fields
        let keyToCheck = 'default-whitelist-mode';
        if (currentSettings[keyToCheck] !== undefined) {
            currentSettings['default-allowlist-mode'] = currentSettings[keyToCheck];
            delete currentSettings[keyToCheck];
        }

        keyToCheck = 'white-list-domains';
        if (currentSettings[keyToCheck] !== undefined) {
            currentSettings['allowlist-domains'] = currentSettings[keyToCheck];
            delete currentSettings[keyToCheck];
        }

        keyToCheck = 'stealth_disable_stealth_mode';
        if (currentSettings[keyToCheck] !== undefined) {
            currentSettings['stealth-disable-stealth-mode'] = currentSettings[keyToCheck];
            delete currentSettings[keyToCheck];
        }

        keyToCheck = 'custom_filters';
        if (currentSettings[keyToCheck] !== undefined) {
            currentSettings['custom-filters'] = currentSettings[keyToCheck];
            delete currentSettings[keyToCheck];
        }

        // New group state 'touched' field added in 4.2
        // zod 'parse then transform' approach is used to transform data to actual schema
        if (typeof currentSettings['groups-state'] === 'string') {
            // create data transformer
            const groupsStateTransformer = zod.record(
                zod.object({
                    enabled: zod.boolean().optional(),
                }).passthrough().transform((data) => {
                    const enabled = Boolean(data.enabled);
                    return {
                        ...data,
                        enabled,
                        touched: enabled,
                    };
                }),
            );

            const currentGroupsStateData = JSON.parse(currentSettings['groups-state']);
            currentSettings['groups-state'] = JSON.stringify(
                groupsStateTransformer.parse(currentGroupsStateData),
            );
        }

        // Check non exists fields in filters-state
        if (typeof currentSettings['filters-state'] === 'string') {
            const filtersStateTransformer = zod.record(
                zod.object({
                    enabled: zod.boolean().optional(),
                    installed: zod.boolean().optional(),
                }).passthrough().transform(({ installed, enabled, ...rest }) => ({
                    ...rest,
                    enabled: Boolean(enabled),
                    installed: Boolean(installed),
                })),
            );

            const filtersState = JSON.parse(currentSettings['filters-state']);

            currentSettings['filters-state'] = JSON.stringify(filtersStateTransformer.parse(filtersState));
        }

        // Check not exists fields in custom filters
        if (typeof currentSettings['custom-filters'] === 'string') {
            const customFiltersDataTransformer = zod
                .object({
                    trusted: zod.boolean().optional(),
                    timeUpdated: zod.number().or(zod.string()).optional(),
                })
                .passthrough()
                .transform((data) => {
                    const trusted = Boolean(data.trusted);
                    const timeUpdated = typeof data.timeUpdated === 'undefined' ? 0 : Number(data.timeUpdated);

                    // Remove deprecated field.
                    if (data.languages !== undefined) {
                        delete data.languages;
                    }

                    return {
                        ...data,
                        trusted,
                        timeUpdated,
                    };
                })
                .array();

            const customFilters = JSON.parse(currentSettings['custom-filters']);

            currentSettings['custom-filters'] = JSON.stringify(customFiltersDataTransformer.parse(customFilters));
        }

        // Check not exists fields in filters version for custom filters
        if (typeof currentSettings['filters-version'] === 'string') {
            const filtersVersionsTransformer = zod.record(zod.object({
                lastUpdateTime: zod.number().optional(),
            }).passthrough().transform(({ lastUpdateTime, ...rest }) => ({
                ...rest,
                lastUpdateTime: lastUpdateTime ?? 0,
            })));

            const filtersVersion = JSON.parse(currentSettings['filters-version']);

            currentSettings['filters-version'] = JSON.stringify(filtersVersionsTransformer.parse(filtersVersion));
        }

        // mode notification data from settings to root storage
        await UpdateApi.moveStorageData('viewed-notifications', currentSettings);
        await UpdateApi.moveStorageData('viewed-notification-time', currentSettings);

        // move client id from settings to root storage
        await UpdateApi.moveStorageData('client-id', currentSettings);

        // move page stats to root storage
        await UpdateApi.moveStorageData('page-statistic', currentSettings);

        // move safebrowsing from settings data to root storage
        await UpdateApi.moveStorageData('safebrowsing-suspended-from', currentSettings);
        await UpdateApi.moveStorageData('sb-lru-cache', currentSettings);

        const settingsValidator = zod.object({
            'appearance-theme': zod.preprocess((value: unknown) => {
                if (typeof value === 'string' && value.includes('\"')) {
                    return JSON.parse(value);
                }
                return value;
            }, zod.enum(['system', 'dark', 'light'])),
            'disable-show-page-statistic': SchemaPreprocessor.booleanValidator,
            'detect-filters-disabled': SchemaPreprocessor.booleanValidator,
            'safebrowsing-disabled': SchemaPreprocessor.booleanValidator,
            'filters-update-period': SchemaPreprocessor.numberValidator,
            'use-optimized-filters': SchemaPreprocessor.booleanValidator,
            'hits-count-disabled': SchemaPreprocessor.booleanValidator,
            'context-menu-disabled': SchemaPreprocessor.booleanValidator,
            'show-info-about-adguard-disabled': SchemaPreprocessor.booleanValidator,
            'show-app-updated-disabled': SchemaPreprocessor.booleanValidator,
            'hide-rate-block': SchemaPreprocessor.booleanValidator,
            'user-rules-editor-wrap': SchemaPreprocessor.booleanValidator,
            'allowlist-domains': zod.string(),
            'block-list-domains': zod.string(),
            'allowlist-enabled': SchemaPreprocessor.booleanValidator,
            'default-allowlist-mode': SchemaPreprocessor.booleanValidator,
            'stealth-disable-stealth-mode': SchemaPreprocessor.booleanValidator,
            'stealth-hide-referrer': SchemaPreprocessor.booleanValidator,
            'stealth-hide-search-queries': SchemaPreprocessor.booleanValidator,
            'stealth-send-do-not-track': SchemaPreprocessor.booleanValidator,
            'stealth-block-webrtc': SchemaPreprocessor.booleanValidator,
            'stealth-remove-x-client': SchemaPreprocessor.booleanValidator,
            'stealth-block-third-party-cookies': SchemaPreprocessor.booleanValidator,
            'stealth-block-third-party-cookies-time': SchemaPreprocessor.numberValidator,
            'stealth-block-first-party-cookies': SchemaPreprocessor.booleanValidator,
            'stealth-block-first-party-cookies-time': SchemaPreprocessor.numberValidator,
            'user-filter-enabled': SchemaPreprocessor.booleanValidator,
            'filters-state': zod.string().optional(),
            'filters-version': zod.string().optional(),
            'groups-state': zod.string().optional(),
            'custom-filters': zod.string().optional(),
            'adguard-disabled': SchemaPreprocessor.booleanValidator,
        });

        // merge current with default settings and validate
        const settings = settingsValidator.parse({ ...defaultSettings, ...currentSettings });

        // set new settings to storage
        await browserStorage.set('adguard-settings', settings);
    }

    /**
     * Moves data from settings to root storage.
     *
     * @param key Settings key.
     * @param currentSettings Current settings object.
     */
    private static async moveStorageData(
        key: string,
        currentSettings: Record<string, unknown>,
    ): Promise<void> {
        const data = currentSettings?.[key];

        if (data) {
            delete currentSettings[key];
            await browserStorage.set(key, data);
        }
    }
}
