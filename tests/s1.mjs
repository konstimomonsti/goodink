export default async ({ win, shot }) => {
  await win.waitForTimeout(1500);
  await shot('01-onboarding');
  await win.getByRole('button', { name: 'Skip' }).click();
  await win.waitForTimeout(300);
  await shot('02-library-empty');
};
