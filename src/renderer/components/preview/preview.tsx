import * as React from 'react';
import {
    Users, MessageSquare, Activity, Play, Check, X, Settings, Plus, Search
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusDot } from '@/components/ui/status-dot';
import { List, ListRow } from '@/components/ui/list';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sidebar, SidebarSection, SidebarItem } from '@/components/ui/sidebar';

/** A labelled group, so the showcase reads as sections rather than a wall of controls. */
function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</h2>
            <div className="flex flex-wrap items-center gap-3">{children}</div>
        </section>
    );
}

/**
 * The dev-only primitives showcase. It renders every primitive and its variants so the
 * foundation is reviewable, and the Retint button proves the token model: it flips the
 * --primary token on the root, and every primitive that reads bg-primary recolors at
 * once, because none of them hardcode a color.
 */
export function Preview(): React.JSX.Element {
    const [retinted, setRetinted] = React.useState(false);

    const toggleRetint = (): void => {
        const root = document.documentElement;
        if (retinted) {
            root.style.removeProperty('--primary');
            root.style.removeProperty('--primary-foreground');
        } else {
            // A deliberately loud value, so the recolor is unmistakable in a screenshot.
            root.style.setProperty('--primary', 'oklch(0.62 0.19 250)');
            root.style.setProperty('--primary-foreground', 'oklch(0.985 0 0)');
        }
        setRetinted(!retinted);
    };

    return (
        <div className="bg-background text-foreground min-h-dvh">
            <div className="flex min-h-dvh">
                <Sidebar>
                    <SidebarSection>Stafford</SidebarSection>
                    <SidebarItem active><Users /> Roster</SidebarItem>
                    <SidebarItem><MessageSquare /> Conversations</SidebarItem>
                    <SidebarItem><Activity /> Activity</SidebarItem>
                    <div className="mt-auto" />
                    <SidebarItem><Settings /> Settings</SidebarItem>
                </Sidebar>

                <main className="flex-1 overflow-auto p-8">
                    <div className="mx-auto flex max-w-4xl flex-col gap-8">
                        <header className="flex items-center justify-between gap-4">
                            <div>
                                <h1 className="text-lg font-semibold">Design system primitives</h1>
                                <p className="text-muted-foreground text-sm">
                                    The shadcn foundation in the dark register, built with Radix, Lucide, and CVA.
                                </p>
                            </div>
                            <Button variant="outline" onClick={toggleRetint}>
                                {retinted ? 'Reset primary token' : 'Retint primary token'}
                            </Button>
                        </header>

                        <Section title="Buttons">
                            <Button>Default</Button>
                            <Button variant="secondary">Secondary</Button>
                            <Button variant="outline">Outline</Button>
                            <Button variant="ghost">Ghost</Button>
                            <Button variant="destructive">Destructive</Button>
                            <Button variant="link">Link</Button>
                            <Button size="sm"><Plus /> New</Button>
                            <Button size="icon" aria-label="Search"><Search /></Button>
                        </Section>

                        <Section title="Badges">
                            <Badge>Default</Badge>
                            <Badge variant="secondary">Secondary</Badge>
                            <Badge variant="outline">Outline</Badge>
                            <Badge variant="destructive"><X /> Failed</Badge>
                            <Badge variant="secondary"><Check /> Done</Badge>
                        </Section>

                        <Section title="Status">
                            <span className="flex items-center gap-2 text-sm"><StatusDot status="working" pulse /> Working</span>
                            <span className="flex items-center gap-2 text-sm"><StatusDot status="idle" /> Idle</span>
                            <span className="flex items-center gap-2 text-sm"><StatusDot status="waiting" /> Waiting</span>
                            <span className="flex items-center gap-2 text-sm"><StatusDot status="error" /> Error</span>
                            <span className="flex items-center gap-2 text-sm"><StatusDot status="offline" /> Offline</span>
                        </Section>

                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Ada</CardTitle>
                                    <CardDescription>Lead developer on Stafford</CardDescription>
                                </CardHeader>
                                <CardContent className="flex items-center gap-2 text-sm">
                                    <StatusDot status="working" pulse /> Working, 2 tools this turn
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Compose</CardTitle>
                                    <CardDescription>Inputs flex for longer translated text</CardDescription>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-3">
                                    <Input placeholder="Project name" />
                                    <Textarea placeholder="Message a colleague" />
                                </CardContent>
                            </Card>
                        </div>

                        <Section title="Tabs">
                            <Tabs defaultValue="conversation" className="w-full">
                                <TabsList>
                                    <TabsTrigger value="conversation">Conversation</TabsTrigger>
                                    <TabsTrigger value="activity">Activity</TabsTrigger>
                                </TabsList>
                                <TabsContent value="conversation" className="text-muted-foreground text-sm">The message exchange.</TabsContent>
                                <TabsContent value="activity" className="text-muted-foreground text-sm">What the colleague did.</TabsContent>
                            </Tabs>
                        </Section>

                        <Section title="List rows">
                            <List className="w-full">
                                <ListRow data-active="true">
                                    <StatusDot status="working" pulse />
                                    <span className="flex-1">Ada, running the build</span>
                                    <Badge variant="secondary">working</Badge>
                                </ListRow>
                                <ListRow>
                                    <StatusDot status="waiting" />
                                    <span className="flex-1">Boris, waiting for you</span>
                                    <Badge variant="outline">waiting</Badge>
                                </ListRow>
                                <ListRow>
                                    <StatusDot status="idle" />
                                    <span className="flex-1">Marion, idle</span>
                                    <Badge variant="outline">idle</Badge>
                                </ListRow>
                            </List>
                        </Section>

                        <Section title="Scroll area and separator">
                            <ScrollArea className="h-28 w-full rounded-md border">
                                <div className="flex flex-col p-3 text-sm">
                                    <span>Read src/main/index.ts</span>
                                    <Separator className="my-2" />
                                    <span>Wrote note.txt</span>
                                    <Separator className="my-2" />
                                    <span><Play className="inline size-3" /> Ran the build</span>
                                </div>
                            </ScrollArea>
                        </Section>
                    </div>
                </main>
            </div>
        </div>
    );
}
