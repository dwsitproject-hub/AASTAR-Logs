import { useEffect, useRef, useState } from 'react';
import { getRealtimeStatus, subscribeRealtime } from '../services/realtime';

export function useRealtimeStatus() {
  const [status, setStatus] = useState(getRealtimeStatus());

  useEffect(() => subscribeRealtime(message => {
    if (message.type === 'connection.status') setStatus(message.status);
  }), []);

  return status;
}

export function useRealtimeEvent(handler) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => subscribeRealtime(message => {
    if (message.type === 'data.updated') handlerRef.current(message);
  }), []);
}

export function useRealtimeMessage(handler) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => subscribeRealtime(message => {
    handlerRef.current(message);
  }), []);
}
