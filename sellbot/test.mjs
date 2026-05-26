/**
 * Локальный тест осмотра (без сервера): node test.mjs
 * Полный цикл — sellbot + sell с тестовым заказом по WS.
 */
import { lookAroundSpinStepCount } from './lib/afk-look.mjs';

console.log('afk-look steps:', lookAroundSpinStepCount());
console.log('Запуск: npm start в sellbot, npm start в sell');
