// joinPath: library paths are built with the separator of the system they live on (Windows "\",
// Linux and Android "/"), so files open on every system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPath } from '../../src/renderer/lib/util.ts';

test('Windows paths keep backslashes', () => {
  assert.equal(joinPath(String.raw`C:\Users\k\Documents\goodink`, 'Folder/Lecture.pdf'), String.raw`C:\Users\k\Documents\goodink\Folder\Lecture.pdf`);
  assert.equal(joinPath('D:\\Sync\\', 'goodink Notebooks'), String.raw`D:\Sync\goodink Notebooks`);
});

test('Linux paths use slashes', () => {
  assert.equal(joinPath('/home/tester/Documents/goodink/', 'Folder/Lecture slides.pdf'), '/home/tester/Documents/goodink/Folder/Lecture slides.pdf');
  assert.equal(joinPath('/home/tester/Documents/goodink', 'a.pdf'), '/home/tester/Documents/goodink/a.pdf');
});
