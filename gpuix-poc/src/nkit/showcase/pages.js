import ButtonPage from './pages/ButtonPage.svelte';
import ChipPage from './pages/ChipPage.svelte';
import CardPage from './pages/CardPage.svelte';
import TextPage from './pages/TextPage.svelte';
import LayoutPage from './pages/LayoutPage.svelte';
import AvatarPage from './pages/AvatarPage.svelte';
import AlertPage from './pages/AlertPage.svelte';
import LoadingPage from './pages/LoadingPage.svelte';
import StatEmptyPage from './pages/StatEmptyPage.svelte';
import ChoicePage from './pages/ChoicePage.svelte';
import InputPage from './pages/InputPage.svelte';
import TextareaPage from './pages/TextareaPage.svelte';
import SliderPage from './pages/SliderPage.svelte';
import SelectPage from './pages/SelectPage.svelte';
import TabsPage from './pages/TabsPage.svelte';
import AccordionPage from './pages/AccordionPage.svelte';
import SidebarPage from './pages/SidebarPage.svelte';
import ResizablePage from './pages/ResizablePage.svelte';
import NavPage from './pages/NavPage.svelte';
import TreePage from './pages/TreePage.svelte';
import TablePage from './pages/TablePage.svelte';
import OverlayPage from './pages/OverlayPage.svelte';
import DialogPage from './pages/DialogPage.svelte';
import ContentPage from './pages/ContentPage.svelte';
import ThemePage from './pages/ThemePage.svelte';

export const pages = [
	{ name: 'Button', group: 'Forms', component: ButtonPage },
	{ name: 'Choice controls', group: 'Forms', component: ChoicePage },
	{ name: 'Input / Field', group: 'Forms', component: InputPage },
	{ name: 'Textarea', group: 'Forms', component: TextareaPage },
	{ name: 'Select', group: 'Forms', component: SelectPage },
	{ name: 'Slider', group: 'Forms', component: SliderPage },
	{ name: 'Card', group: 'Display', component: CardPage },
	{ name: 'Chip / Badge', group: 'Display', component: ChipPage },
	{ name: 'Avatar', group: 'Display', component: AvatarPage },
	{ name: 'Alert', group: 'Display', component: AlertPage },
	{ name: 'Skeleton / Spinner / Progress', group: 'Display', component: LoadingPage },
	{ name: 'Stat / Empty', group: 'Display', component: StatEmptyPage },
	{ name: 'Text / Heading', group: 'Display', component: TextPage },
	{ name: 'Separator / Kbd', group: 'Layout', component: LayoutPage },
	{ name: 'Sidebar', group: 'Layout', component: SidebarPage },
	{ name: 'Resizable', group: 'Layout', component: ResizablePage },
	{ name: 'Tabs', group: 'Nav', component: TabsPage },
	{ name: 'Accordion', group: 'Nav', component: AccordionPage },
	{ name: 'Breadcrumbs / Pagination', group: 'Nav', component: NavPage },
	{ name: 'Tree', group: 'Nav', component: TreePage },
	{ name: 'Table / VirtualList', group: 'Nav', component: TablePage },
	{ name: 'Popover / Tooltip / Menu', group: 'Overlay', component: OverlayPage },
	{ name: 'Dialog / Toast', group: 'Overlay', component: DialogPage },
	{ name: 'Markdown / Code / Diff', group: 'Content', component: ContentPage },
	{ name: 'Theme', group: 'Theming', component: ThemePage },
];
