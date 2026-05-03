import React from 'react';
import { ChatPage } from '../components/chat/ChatPage';

export const ChatView: React.FC = () => {
  const [initialPrompt] = React.useState(() => sessionStorage.getItem('chat_initial_prompt') || undefined);

  React.useEffect(() => {
    if (initialPrompt) {
      sessionStorage.removeItem('chat_initial_prompt');
    }
  }, [initialPrompt]);

  return <ChatPage initialPrompt={initialPrompt} />;
};
