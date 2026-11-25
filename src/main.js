import { createScene } from './scene.js';

const menu = document.getElementById('menu');
const startButton = document.getElementById('start');

startButton.focus();
startButton.addEventListener('click', () => {
  menu.classList.add('hidden');
  createScene(document.getElementById('app'));
});
