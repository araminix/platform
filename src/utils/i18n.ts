import { logger } from '@araminix/lib';

/**
 * Translation dictionaries by language. Every language that is present must translate every text key.
 *
 * @typeParam LANGUAGE - Language codes, for example `'en' | 'de'`.
 * @typeParam TEXT - Text keys, for example `'save' | 'cancel'`.
 *
 * @example
 * ```ts
 * const translations: Translations<'en' | 'de', 'save' | 'cancel'> = {
 *     en: { save: 'Save', cancel: 'Cancel' },
 *     de: { save: 'Speichern', cancel: 'Abbrechen' },
 * };
 * ```
 */
export type Translations<LANGUAGE extends string | number, TEXT extends string> = {
    [key in LANGUAGE]?: {
        [key in TEXT]: string;
    };
};

/**
 * Small, type-safe translation service. The compiler checks text keys and language codes; at runtime a missing language
 * or text falls back to the key itself and logs a warning, so a missing translation never breaks rendering.
 *
 * @typeParam LANGUAGE - Language codes.
 * @typeParam TEXT - Text keys.
 *
 * @remarks
 * {@link AppIndex} declares a protected `i18n` field of this type for apps to use; the platform does not set it, so
 * assign it yourself (for example in your `AppIndex` subclass) and pick the language per user, e.g. from
 * {@link UserInfo.language}.
 *
 * @example
 * ```ts
 * import { I18nService } from '@araminix/platform';
 *
 * type Lang = 'en' | 'de';
 * type Text = 'title' | 'save';
 *
 * const i18n = new I18nService<Lang, Text>('en');
 * i18n.loadTranslations({
 *     en: { title: 'Tasks', save: 'Save' },
 *     de: { title: 'Aufgaben', save: 'Speichern' },
 * });
 *
 * i18n.t('save'); // 'Save'
 * i18n.t('save', 'de'); // 'Speichern'
 * i18n.setLanguage('de');
 * i18n.t('title'); // 'Aufgaben'
 * ```
 */
export class I18nService<LANGUAGE extends string | number, TEXT extends string> {
    /** Loaded dictionaries by language. */
    protected translations: Translations<LANGUAGE, TEXT> = {};
    /** Language used by {@link I18nService.t} when no language is passed. */
    protected language: LANGUAGE;

    /**
     * @param language - Initial current language.
     */
    constructor(language: LANGUAGE) {
        this.language = language;
    }

    /**
     * Adds or replaces the dictionaries of every language present in `allTranslations`; other languages stay loaded.
     *
     * @param allTranslations - Dictionaries by language.
     * @throws Error when a language key is present but its dictionary is `undefined` or `null` (the error is logged too).
     */
    loadTranslations(allTranslations: Translations<LANGUAGE, TEXT>): void {
        for (const language of Object.keys(allTranslations) as LANGUAGE[]) {
            if (!allTranslations[language]) {
                logger.error(`I18nService: Translations for language ${String(language)} are missing.`);
                throw new Error(`I18nService: Translations for language ${String(language)} are missing.`);
            }
            this.translations[language] = allTranslations[language];
        }
    }

    /**
     * Changes the current language, which {@link I18nService.t} uses when called without a language.
     *
     * @param language - New current language.
     */
    setLanguage(language: LANGUAGE): void {
        this.language = language;
    }

    /** Get the current language */
    getCurrentLanguage(): LANGUAGE {
        return this.language;
    }

    /**
     * Translates `text`.
     *
     * @param text - Text key.
     * @param lang - Language to use instead of the current one.
     * @returns The translation, or `text` itself (with a logged warning) when the language is not loaded or has no entry
     *     for the key. An empty translation is returned as is, without a warning.
     */
    t(text: TEXT, lang?: LANGUAGE): string {
        const language = lang ?? this.language;
        if (!this.translations[language]) {
            logger.warn(`I18nService - Invalid LANGUAGE or missing translations:`, { text, language });
            return text;
        }
        const translated = this.translations[language]![text];
        if (translated === undefined) {
            logger.warn(`I18nService - Missing TEXT translation:`, { text, language });
        }
        return translated ?? text;
    }
}
