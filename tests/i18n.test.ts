import assert from 'node:assert';
import { describe, it } from 'node:test';

import { I18nService } from '../src/utils/i18n.js';

type Lang = 'en' | 'ru' | 'tr';
type Key = 'hello' | 'bye';

describe('I18nService', () => {
    it('translates known keys', () => {
        const i18n = new I18nService<Lang, Key>('en');
        i18n.loadTranslations({
            en: { hello: 'Hello', bye: 'Goodbye' },
            ru: { hello: 'Привет', bye: 'Пока' },
        });

        assert.strictEqual(i18n.t('hello'), 'Hello');
        assert.strictEqual(i18n.t('bye'), 'Goodbye');
        assert.strictEqual(i18n.t('hello', 'ru'), 'Привет');
    });

    it('switches language and falls back to key on missing translation', () => {
        const i18n = new I18nService<Lang, Key>('en');
        i18n.loadTranslations({
            en: { hello: 'Hello', bye: 'Goodbye' },
        });

        i18n.setLanguage('ru');
        assert.strictEqual(i18n.getCurrentLanguage(), 'ru');
        assert.strictEqual(i18n.t('hello'), 'hello'); // fallback
    });
});
