import { useRecoilCallback } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { clearLocalStorage } from '~/utils/localStorage';
import store from '~/store';

export default function useClearStates() {
  const clearConversations = store.useClearConvoState();
  const clearSubmissions = store.useClearSubmissionState();

  const clearStates = useRecoilCallback(
    ({ reset, snapshot }) =>
      async (skipFirst?: boolean) => {
        if (skipFirst !== true) {
          reset(store.sessionReasoningEffortFamily(Constants.NEW_CONVO));
        }
        const conversationKeys = await snapshot.getPromise(store.conversationKeysAtom);
        const sessionConversationIds = await Promise.all(
          conversationKeys.map(async (key) => ({
            key,
            conversationId: (await snapshot.getPromise(store.conversationByIndex(key)))
              ?.conversationId,
          })),
        );
        await clearSubmissions(skipFirst);
        await clearConversations(skipFirst);

        for (const { key, conversationId } of sessionConversationIds) {
          if (skipFirst === true && key === 0) {
            continue;
          }

          reset(store.filesByIndex(key));
          reset(store.presetByIndex(key));
          reset(store.textByIndex(key));
          reset(store.showStopButtonByIndex(key));
          reset(store.abortScrollFamily(key));
          reset(store.isSubmittingFamily(key));
          reset(store.optionSettingsFamily(key));
          reset(store.showPopoverFamily(key));
          reset(store.showMentionPopoverFamily(key));
          reset(store.showPlusPopoverFamily(key));
          reset(store.showPromptsPopoverFamily(key));
          reset(store.showSkillsPopoverFamily(key));
          reset(store.pendingManualSkillsByConvoId(key.toString()));
          reset(store.pendingQuotesByConvoId(key.toString()));
          /**
           * Pending skill/quote queues are keyed by the conversation id the
           * composer wrote under, not this UI index — also clear by the resolved
           * id so queued-but-unsent selections don't linger in Recoil.
           */
          if (conversationId != null) {
            reset(store.sessionReasoningEffortFamily(conversationId));
            reset(store.pendingManualSkillsByConvoId(conversationId));
            reset(store.pendingQuotesByConvoId(conversationId));
          }
          reset(store.activePromptByIndex(key));
          reset(store.globalAudioURLFamily(key));
          reset(store.globalAudioFetchingFamily(key));
          reset(store.globalAudioPlayingFamily(key));
          reset(store.activeRunFamily(key));
          reset(store.audioRunFamily(key));
          reset(store.messagesSiblingIdxFamily(key.toString()));
        }

        clearLocalStorage(skipFirst);
      },
    [],
  );

  return clearStates;
}
