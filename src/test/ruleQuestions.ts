import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/**
 * Answers the appearance-count questions (出場回数の確認) that SETUP shows before generating a
 * format whose caps nobody has stated, then confirms — which generates. Every question gets
 * the same answer.
 */
export async function answerRuleQuestions(user: ReturnType<typeof userEvent.setup>, answer: 'はい' | 'いいえ' = 'いいえ'): Promise<string[]> {
  const dialog = await screen.findByRole('dialog', { name: '出場回数の確認' });
  const groups = within(dialog).getAllByRole('radiogroup');
  for (const group of groups) await user.click(within(group).getByRole('radio', { name: answer }));
  const asked = groups.map((group) => group.getAttribute('aria-label') ?? '');
  await user.click(within(dialog).getByTestId('rule-questions-confirm'));
  return asked;
}
