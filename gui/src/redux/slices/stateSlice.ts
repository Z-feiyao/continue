import { PayloadAction, createSlice } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ChatHistoryItem,
  ChatMessage,
  Checkpoint,
  ContextItemWithId,
  PersistedSessionInfo,
  PromptLog,
  ToolCall,
} from "core";
import { BrowserSerializedContinueConfig } from "core/config/load";
import { ConfigValidationError } from "core/config/validation";
import { ApplyState } from "core/protocol/ideWebview";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4, v4 } from "uuid";
import { ToolState } from "../../pages/gui/ToolCallDiv/types";

interface CurrentToolCallState {
  currentToolCallId?: string;
  currentToolCallState?: ToolState;
  toolCall?: ToolCall;
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
};
type State = {
  currentToolCallState: CurrentToolCallState;
  history: ChatHistoryItemWithMessageId[];
  active: boolean;
  isGatheringContext: boolean;
  checkpoints: Checkpoint[];
  applyStates: ApplyState[];
  nextCodeBlockToApplyIndex: number;
  streamAborter: AbortController;
  curCheckpointIndex: number;

  ttsActive: boolean;
  config: BrowserSerializedContinueConfig;
  title: string;
  sessionId: string;
  defaultModelTitle: string;
  mainEditorContent?: JSONContent;
  selectedProfileId: string;
  configError: ConfigValidationError[] | undefined;
  isMultifileEdit: boolean;
};

const initialState: State = {
  currentToolCallState: {
    currentToolCallId: undefined,
    currentToolCallState: undefined,
  },
  history: [],
  ttsActive: false,
  active: false,
  isGatheringContext: false,
  configError: undefined,
  config: {
    slashCommands: [
      {
        name: "share",
        description: "Export the current chat session to markdown",
      },
      {
        name: "cmd",
        description: "Generate a shell command",
      },
    ],
    contextProviders: [],
    models: [],
  },
  title: "New Session",
  sessionId: v4(),
  defaultModelTitle: "GPT-4",
  selectedProfileId: "local",
  checkpoints: [],
  isMultifileEdit: false,
  curCheckpointIndex: 0,
  nextCodeBlockToApplyIndex: 0,
  applyStates: [],
  streamAborter: new AbortController(),
};

export const stateSlice = createSlice({
  name: "state",
  initialState,
  reducers: {
    setConfig: (
      state,
      { payload: config }: PayloadAction<BrowserSerializedContinueConfig>,
    ) => {
      const defaultModelTitle =
        config.models.find((model) => model.title === state.defaultModelTitle)
          ?.title ||
        config.models[0]?.title ||
        "";
      state.config = config;
      state.defaultModelTitle = defaultModelTitle;
    },
    setConfigError: (
      state,
      { payload: error }: PayloadAction<ConfigValidationError[] | undefined>,
    ) => {
      state.configError = error;
    },
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }
      const lastHistory = state.history[state.history.length - 1];

      lastHistory.promptLogs = lastHistory.promptLogs
        ? lastHistory.promptLogs.concat(payload)
        : payload;
    },
    setTTSActive: (state, { payload }: PayloadAction<boolean>) => {
      state.ttsActive = payload;
    },
    setActive: (state) => {
      state.active = true;
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      state.isGatheringContext = payload;
    },
    clearLastResponse: (state) => {
      if (state.history.length < 2) {
        return;
      }
      state.mainEditorContent =
        state.history[state.history.length - 2].editorState;
      state.history = state.history.slice(0, -2);
    },
    consumeMainEditorContent: (state) => {
      state.mainEditorContent = undefined;
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.history[index].contextItems = contextItems;
      }
    },
    resubmitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const historyItem = state.history[payload.index];
      if (!historyItem) {
        return;
      }
      historyItem.message.content = "";
      historyItem.editorState = payload.editorState;

      // Cut off history after the resubmitted message
      state.history = state.history.slice(0, payload.index + 1).concat({
        message: {
          id: uuidv4(),
          role: "assistant",
          content: "",
        },
        contextItems: [],
      });

      state.currentToolCallState = {};

      // https://github.com/continuedev/continue/pull/1021
      state.active = true;
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.history.splice(action.payload - 1, 2);
    },
    initNewActiveMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        editorState: JSONContent;
      }>,
    ) => {
      state.history.push({
        message: { role: "user", content: "", id: uuidv4() },
        contextItems: [],
        editorState: payload.editorState,
      });
      state.history.push({
        message: {
          id: uuidv4(),
          role: "assistant",
          content: "",
        },
        contextItems: [],
      });

      state.active = true;
      state.curCheckpointIndex = state.curCheckpointIndex + 1;
    },
    setMessageAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        message: ChatMessage;
        index: number;
        contextItems?: ContextItemWithId[];
      }>,
    ) => {
      if (payload.index >= state.history.length) {
        state.history.push({
          message: { ...payload.message, id: uuidv4() },
          editorState: {
            type: "doc",
            content: renderChatMessage(payload.message)
              .split("\n")
              .map((line) => ({
                type: "paragraph",
                content: line === "" ? [] : [{ type: "text", text: line }],
              })),
          },
          contextItems: [],
        });
        return;
      }
      state.history[payload.index].message = {
        ...payload.message,
        id: uuidv4(),
      };
      state.history[payload.index].contextItems = payload.contextItems || [];
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];
      if (!historyItem) {
        return;
      }
      historyItem.contextItems.push(...payload.contextItems);
    },
    setInactive: (state) => {
      state.isGatheringContext = false;
      state.active = false;
    },
    cancelGeneration: (state) => {
      state.isGatheringContext = false;
      state.active = false;
      state.currentToolCallState = {};
    },
    abortStream: (state) => {
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage>) => {
      if (state.history.length) {
        const lastMessage = state.history[state.history.length - 1];

        if (
          action.payload.role &&
          (lastMessage.message.role !== action.payload.role ||
            // This is when a tool call comes after assistant text
            (lastMessage.message.content !== "" &&
              action.payload.role === "assistant" &&
              action.payload.toolCalls?.length))
        ) {
          // Create a new message
          state.history.push({
            contextItems: [],
            message: { id: "NONE", ...action.payload },
          });
        } else {
          // Add to the existing message
          const msg = state.history[state.history.length - 1].message;
          if (action.payload.content) {
            msg.content += renderChatMessage(action.payload);
          } else if (
            action.payload.role === "assistant" &&
            action.payload.toolCalls &&
            msg.role === "assistant"
          ) {
            if (!msg.toolCalls) {
              msg.toolCalls = [];
            }
            action.payload.toolCalls.forEach((toolCall, i) => {
              if (msg.toolCalls.length <= i) {
                msg.toolCalls.push(toolCall);
              } else {
                msg.toolCalls[i].function.arguments +=
                  toolCall.function.arguments;
              }
            });
          }
        }
      }
    },
    newSession: (
      state,
      { payload }: PayloadAction<PersistedSessionInfo | undefined>,
    ) => {
      state.streamAborter.abort();
      state.streamAborter = new AbortController();

      state.active = false;
      state.isGatheringContext = false;
      state.isMultifileEdit = false;
      state.currentToolCallState = {};
      if (payload) {
        state.history = payload.history as any;
        state.title = payload.title;
        state.sessionId = payload.sessionId;
        state.checkpoints = payload.checkpoints;
        state.curCheckpointIndex = 0;
      } else {
        state.history = [];
        state.title = "New Session";
        state.sessionId = v4();
        state.checkpoints = [];
        state.curCheckpointIndex = 0;
      }
    },
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];
      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });
      const base = payload.rangeInFileWithContents.filepath
        .split(/[\\/]/)
        .pop();

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;
      contextItems.push({
        name: `${base} ${lineNums}`,
        description: payload.rangeInFileWithContents.filepath,
        id: {
          providerTitle: "code",
          itemId: v4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
      });
      state.history[state.history.length - 1].contextItems = contextItems;
    },
    setDefaultModel: (
      state,
      { payload }: PayloadAction<{ title: string; force?: boolean }>,
    ) => {
      const model = state.config.models.find(
        (model) => model.title === payload.title,
      );
      if (!model && !payload.force) return;
      return {
        ...state,
        defaultModelTitle: payload.title,
      };
    },
    setSelectedProfileId: (state, { payload }: PayloadAction<string>) => {
      return {
        ...state,
        selectedProfileId: payload,
      };
    },

    setIsInMultifileEdit: (state, { payload }: PayloadAction<boolean>) => {
      state.isMultifileEdit = payload;
    },
    setCurCheckpointIndex: (state, { payload }: PayloadAction<number>) => {
      state.curCheckpointIndex = payload;
    },
    updateCurCheckpoint: (
      state,
      { payload }: PayloadAction<{ filepath: string; content: string }>,
    ) => {
      state.checkpoints[state.curCheckpointIndex] = {
        ...state.checkpoints[state.curCheckpointIndex],
        [payload.filepath]: payload.content,
      };
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const index = state.applyStates.findIndex(
        (applyState) => applyState.streamId === payload.streamId,
      );

      const curApplyState = state.applyStates[index];

      if (index === -1) {
        state.applyStates.push(payload);
      } else {
        curApplyState.status = payload.status ?? curApplyState.status;
        curApplyState.numDiffs = payload.numDiffs ?? curApplyState.numDiffs;
        curApplyState.filepath = payload.filepath ?? curApplyState.filepath;
      }
      if (payload.status === "done") {
        state.nextCodeBlockToApplyIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.nextCodeBlockToApplyIndex = 0;
    },

    // Related to currentToolCallState
    registerCurrentToolCall: (state, { payload }: PayloadAction<string>) => {
      state.currentToolCallState.currentToolCallId = payload;
      state.currentToolCallState.currentToolCallState = "generating";
    },
    cancelToolCall: (state) => {
      state.currentToolCallState.currentToolCallId = undefined;
      state.currentToolCallState.currentToolCallState = undefined;
      state.history[state.history.length - 1].acceptedToolCall = false;
    },
    acceptToolCall: (state) => {
      state.currentToolCallState.currentToolCallId = undefined;
      state.currentToolCallState.currentToolCallState = undefined;
      state.history[state.history.length - 1].acceptedToolCall = true;
    },
    setGeneratedOutput: (state, { payload }: PayloadAction<ToolCall>) => {
      state.currentToolCallState.currentToolCallState = "generated";
      state.currentToolCallState.toolCall = payload;
    },
    setCalling: (state) => {
      state.currentToolCallState.currentToolCallState = "calling";
    },
  },
});

export const {
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setInactive,
  streamUpdate,
  newSession,
  resubmitAtIndex,
  addHighlightedCode,
  setDefaultModel,
  setConfig,
  setConfigError,
  addPromptCompletionPair,
  setTTSActive,
  setActive,
  initNewActiveMessage,
  setMessageAtIndex,
  clearLastResponse,
  consumeMainEditorContent,
  setSelectedProfileId,
  deleteMessage,
  setIsGatheringContext,
  setIsInMultifileEdit,
  updateCurCheckpoint,
  setCurCheckpointIndex,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  // toolCallState
  registerCurrentToolCall,
  setGeneratedOutput,
  cancelToolCall,
  acceptToolCall,
  setCalling,
  abortStream,
} = stateSlice.actions;

export default stateSlice.reducer;
