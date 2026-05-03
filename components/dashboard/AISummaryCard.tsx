import React from 'react';
import { Sun, CalendarCheck, SlidersHorizontal, AlertCircle, Brain, Compass } from 'lucide-react';
import { useNavStore } from '../../store/useNavStore';

export interface SummaryCardDef {
    id: string;
    title: string;
    description: string;
    icon: React.ElementType;
    iconColor: string;
    bgColor: string;
    prompt: string;
}

export const AI_SUMMARY_CARDS: SummaryCardDef[] = [
    {
        id: 'morning-brief',
        title: 'Morning Brief',
        description: 'Everything to kickstart your day',
        icon: Sun,
        iconColor: 'text-amber-400',
        bgColor: 'bg-amber-500/10',
        prompt: 'Give me a morning brief. Summarize what I worked on yesterday, any pending tasks, and what I should focus on today based on my recent activity patterns.',
    },
    {
        id: 'standup',
        title: 'Standup Update',
        description: "What you did, what's next, any blockers",
        icon: CalendarCheck,
        iconColor: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
        prompt: 'Generate a standup update for me. What did I do yesterday? What am I working on today? Are there any potential blockers based on my activity?',
    },
    {
        id: 'custom-summary',
        title: 'Custom Summary',
        description: 'Custom time, filters & instructions',
        icon: SlidersHorizontal,
        iconColor: 'text-purple-400',
        bgColor: 'bg-purple-500/10',
        prompt: 'Create a detailed summary of my activity for the past week. Include which applications I used most, how much time I spent on different categories, and notable patterns.',
    },
    {
        id: 'top-of-mind',
        title: "Top of Mind",
        description: 'Recurring topics ranked by importance',
        icon: AlertCircle,
        iconColor: 'text-red-400',
        bgColor: 'bg-red-500/10',
        prompt: 'What topics and projects have I been focusing on most this week? Rank them by how much time and attention I gave them.',
    },
    {
        id: 'ai-habits',
        title: 'AI Habits',
        description: 'AI usage patterns and model preferences',
        icon: Brain,
        iconColor: 'text-violet-400',
        bgColor: 'bg-violet-500/10',
        prompt: 'Analyze my AI tool usage patterns. Which AI assistants and models have I been using? How often? What types of tasks do I use them for?',
    },
    {
        id: 'discover',
        title: 'Discover',
        description: 'Reminders, Recaps, and More',
        icon: Compass,
        iconColor: 'text-teal-400',
        bgColor: 'bg-teal-500/10',
        prompt: 'What interesting things did I do recently that I might have forgotten about? Any applications or websites I visited briefly that might be worth revisiting?',
    },
];

interface AISummaryCardProps {
    card: SummaryCardDef;
    onClick?: (card: SummaryCardDef) => void;
}

export const AISummaryCard: React.FC<AISummaryCardProps> = ({ card, onClick }) => {
    const setActiveTab = useNavStore((s) => s.setActiveTab);
    const { icon: Icon, title, description, iconColor, bgColor, id } = card;

    const handleClick = () => {
        if (onClick) {
            onClick(card);
            return;
        }
        // Store the prompt for ChatView to pick up
        sessionStorage.setItem('chat_initial_prompt', card.prompt);
        setActiveTab('chat');
    };

    return (
        <button
            id={`ai-summary-${id}`}
            onClick={handleClick}
            className="col-span-1 group relative flex flex-col gap-3 p-4 bg-[#0e0e0e] border border-[#1e1e1e] rounded-xl hover:border-[#333] hover:bg-[#161616] transition-all duration-200 text-left"
        >
            {/* Icon */}
            <div className={`w-9 h-9 rounded-xl ${bgColor} flex items-center justify-center flex-shrink-0`}>
                <Icon className={`w-5 h-5 ${iconColor}`} />
            </div>

            {/* Text */}
            <div>
                <p className="text-sm font-semibold text-gray-200 group-hover:text-white transition-colors">{title}</p>
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{description}</p>
            </div>
        </button>
    );
};
