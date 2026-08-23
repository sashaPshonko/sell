import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cloneTemplateKey,
    itemHasCloneFields,
    mergeCloneSource,
    pickCloneShape,
} from './clone-source.mjs';

test('cloneTemplateKey различает 🎁 и поиск', () => {
    assert.equal(cloneTemplateKey('173КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС', 173), '173:gift');
    assert.equal(cloneTemplateKey('173КК · МОМЕНТАЛЬНО · БОНУС', 173), '173:search');
});

test('pickCloneShape читает category и obtainingType', () => {
    const shaped = pickCloneShape({
        name: '173КК · x',
        category: { id: 'cat-1' },
        obtainingType: { id: 'obt-1' },
        dataFields: [{ id: 'f1', value: 'v' }],
    });
    assert.equal(shaped.category.id, 'cat-1');
    assert.equal(shaped.obtainingType.id, 'obt-1');
    assert.equal(itemHasCloneFields(shaped), true);
});

test('mergeCloneSource не считает живого донора достаточным без полей у sold', () => {
    const sold = { name: '173КК · sold', price: 350, id: 'sold-id' };
    const donor = {
        name: '173КК · live',
        category: { id: 'cat-1' },
        obtainingType: { id: 'obt-1' },
        price: 350,
    };
    const merged = mergeCloneSource(sold, donor);
    assert.equal(merged.category.id, 'cat-1');
    assert.equal(merged.name, '173КК · sold');
    assert.equal(merged.id, 'sold-id');
    assert.equal(itemHasCloneFields(merged), true);
});
