import WebSocket, { WebSocketServer } from 'ws';

import { ipcMain } from 'electron';

import { BackendContext } from '@/types/contexts';

import registerCallback, { SongInfo } from '@/providers/song-info';
import getSongControls from '@/providers/song-controls';
import { RepeatMode } from '@/types/datahost-get-state';

import { APIWebsocketConfig } from '../../config';

let websocket: WebSocketServer | null = null;

let volume: number = 0;
let muted = false;
let repeat: RepeatMode = 'NONE' as RepeatMode;
let shuffle = false;

type PlayerState = {
  song: SongInfo;
  isPlaying: boolean;
  muted: boolean;
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
};

function createPlayerState(
  songInfo: SongInfo | null,
  volume: number,
  repeat: RepeatMode,
  muted: boolean,
  shuffle: boolean,
) {
  return JSON.stringify({
    type: 'PLAYER_STATE',
    song: songInfo,
    isPlaying: songInfo ? !songInfo.isPaused : false,
    muted: muted ?? false,
    position: songInfo?.elapsedSeconds ?? 0,
    volume,
    repeat,
    shuffle: shuffle ?? false,
  });
}

export const register = async ({
  window,
  getConfig,
}: BackendContext<APIWebsocketConfig>) => {
  const config = await getConfig();
  const sockets = new Set<WebSocket>();
  function sendFullState(overrides: Partial<PlayerState> = {}) {
    const state = {
      type: 'PLAYER_STATE',
      repeat,
      song: lastSongInfo ?? undefined,
      isPlaying: lastSongInfo ? !lastSongInfo.isPaused : false,
      muted,
      position: lastSongInfo?.elapsedSeconds ?? 0,
      volume,
      shuffle,
      ...overrides,
    };

    console.log('Sending state:', state);

    sockets.forEach((socket) => socket.send(JSON.stringify(state)));
  }

  let sendTimeout: NodeJS.Timeout | null = null;
  function scheduleSendFullState(overrides: Partial<PlayerState> = {}) {
    if (sendTimeout) clearTimeout(sendTimeout);
    sendTimeout = setTimeout(() => {
      sendFullState(overrides);
      sendTimeout = null;
    }, 100);
  }

  volume = config.volume;

  let lastSongInfo: SongInfo | null = null;

  const controller = getSongControls(window);

  function setLoopStatus(status: RepeatMode) {
    const switches = ['NONE', 'ALL', 'ONE'] as RepeatMode[];

    const currentIndex = switches.indexOf(repeat);
    const targetIndex = switches.indexOf(status);

    const delta = (targetIndex - currentIndex + 3) % 3;
    controller.switchRepeat(delta);
    repeat = status;
    sendFullState({ repeat: status });
  }

  ipcMain.on('ytmd:volume-changed', (_, newVolume: number) => {
    volume = newVolume;
    sendFullState({ volume: volume });
  });

  ipcMain.on('ytmd:repeat-changed', (_, mode: RepeatMode) => {
    repeat = mode;
    sendFullState({ repeat: mode });
  });

  ipcMain.on('ytmd:shuffle-changed', (_, shuffleEnabled: boolean) => {
    shuffle = shuffleEnabled;
    sendFullState({ shuffle: shuffleEnabled });
  });

  ipcMain.on('ytmd:seeked', (_, t: number) => {
    sendFullState({ position: t });
  });

  ipcMain.on('api-websocket:muted-changed-to', (_, isMuted: boolean) => {
    muted = isMuted;
    sendFullState({ muted: isMuted });
  });

  registerCallback((songInfo) => {
    const changed =
      !lastSongInfo ||
      lastSongInfo.videoId !== songInfo.videoId ||
      lastSongInfo.isPaused !== songInfo.isPaused ||
      lastSongInfo.elapsedSeconds !== songInfo.elapsedSeconds;

    if (changed) {
      scheduleSendFullState({
        song: songInfo,
        position: songInfo.elapsedSeconds,
      });
    }

    lastSongInfo = { ...songInfo };
  });

  websocket = new WebSocketServer({
    host: config.hostname,
    port: config.port,
  });

  type Message =
    | {
      type: 'ACTION';
      action: 'play' | 'pause' | 'next' | 'previous' | 'shuffle' | 'mute';
    }
    | { type: 'ACTION'; action: 'repeat'; data: RepeatMode }
    | { type: 'ACTION'; action: 'seek'; data: number }
    | { type: 'ACTION'; action: 'getVolume' }
    | { type: 'ACTION'; action: 'setVolume'; data: number };

  websocket.on('connection', (ws: WebSocket) => {
    ws.send(createPlayerState(lastSongInfo, volume, repeat, muted, shuffle));
    sockets.add(ws);

    ws.on('message', (data: string) => {
      const message = JSON.parse(data.toString()) as Message;

      console.log('Received message:', message);

      switch (message.type) {
        case 'ACTION':
          switch (message.action) {
            case 'play':
              controller.play();
              sendFullState();
              break;
            case 'pause':
              controller.pause();
              sendFullState();
              break;
            case 'next':
              controller.next();
              sendFullState();
              break;
            case 'previous':
              controller.previous();
              sendFullState();
              break;
            case 'shuffle':
              controller.shuffle();
              shuffle = !shuffle;
              sendFullState();
              break;
            case 'mute':
              controller.muteUnmute();
              sendFullState();
              break;
            case 'repeat':
              setLoopStatus(message.data);
              break;
            case 'seek':
              controller.seekTo(message.data);
              sendFullState();
              break;
            case 'setVolume':
              controller.setVolume(message.data);
              sendFullState();
              break;
          }
          break;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
    });
  });
};

export const unregister = () => {
  websocket?.close();
};
