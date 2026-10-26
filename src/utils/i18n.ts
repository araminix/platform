import { logger } from '@araminix/lib';

export type Translations<LANGUAGE extends string | number, TEXT extends string> = {
    [key in LANGUAGE]?: {
        [key in TEXT]: string;
    };
};

/** Define the i18n class with generic language and text types */
export class I18nService<LANGUAGE extends string | number, TEXT extends string> {
    protected translations: Translations<LANGUAGE, TEXT> = {};
    protected language: LANGUAGE;

    constructor(language: LANGUAGE) {
        this.language = language;
    }

    /** Load language translations */
    loadTranslations(allTranslations: Translations<LANGUAGE, TEXT>): void {
        for (const language of Object.keys(allTranslations) as LANGUAGE[]) {
            if (!allTranslations[language]) {
                logger.error(`I18nService: Translations for language ${String(language)} are missing.`);
                throw new Error(`I18nService: Translations for language ${String(language)} are missing.`);
            }
            this.translations[language] = allTranslations[language];
        }
    }

    /** Optionally, set a default language */
    setLanguage(language: LANGUAGE): void {
        this.language = language;
    }

    /** Get the current language */
    getCurrentLanguage(): LANGUAGE {
        return this.language;
    }

    /** Translate a text based on the set language */
    t(text: TEXT, lang?: LANGUAGE): string {
        const language = lang ?? this.language;
        if (!this.translations[language]) {
            logger.warn(`I18nService - Invalid LANGUAGE or missing translations:`, { text, language });
            return text;
        }
        const translated = this.translations[language]![text];
        if (!translated) {
            logger.warn(`I18nService - Missing TEXT translation:`, { text, language });
        }
        return translated ?? text;
    }
}
