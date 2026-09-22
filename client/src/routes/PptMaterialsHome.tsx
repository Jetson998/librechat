import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Download,
  LayoutGrid,
  LogIn,
  Menu,
  Search,
  X,
} from 'lucide-react';
import './PptMaterialsHome.css';
import {
  PPT_EMBEDDED_LOGIN_URL,
  completePptLogin,
  isValidPptAuthMessage,
} from '~/ppt-entry/routing';
import annualReportImage from '~/assets/ppt-materials/annual-report.jpg';
import blueReportImage from '~/assets/ppt-materials/blue-report.jpg';
import businessReportImage from '~/assets/ppt-materials/business-report.jpg';
import careerReportImage from '~/assets/ppt-materials/career-report.jpg';
import freshEducationImage from '~/assets/ppt-materials/fresh-education.jpg';
import greenReportImage from '~/assets/ppt-materials/green-report.jpg';
import minimalReportImage from '~/assets/ppt-materials/minimal-report.jpg';
import quarterlyReportImage from '~/assets/ppt-materials/quarterly-report.jpg';
import reportLinesImage from '~/assets/ppt-materials/report-lines.jpg';
import simpleBlueImage from '~/assets/ppt-materials/simple-blue.jpg';
import teamworkImage from '~/assets/ppt-materials/teamwork.jpg';

type Template = {
  title: string;
  category: string;
  style: string;
  image: string;
  downloads: string;
};

const categories = [
  '首页',
  '免费PPT',
  'PPT模板',
  'PPT图表',
  'PPT素材',
  'PPT背景',
  '行业PPT',
  'PPT下载',
  '不止PPT',
];

const quickTags = [
  '工作总结',
  '商务汇报',
  '毕业答辩',
  '教育培训',
  '商业计划',
  '简约PPT',
  '中国风',
  '年终总结',
];

const templates: Template[] = [
  {
    title: '蓝色 2026 工作总结汇报 PPT 模板',
    category: '工作总结',
    style: '商务 · 简约',
    image: annualReportImage,
    downloads: '2.4K',
  },
  {
    title: '橙蓝扁平化员工晋升竞聘报告',
    category: '述职竞聘',
    style: '扁平 · 活力',
    image: careerReportImage,
    downloads: '1.8K',
  },
  {
    title: '红蓝插画风团结一心携手共进',
    category: '团队建设',
    style: '插画 · 通用',
    image: teamworkImage,
    downloads: '1.5K',
  },
  {
    title: '创意简约风新跨越向未来季度汇报',
    category: '工作汇报',
    style: '创意 · 清爽',
    image: quarterlyReportImage,
    downloads: '1.3K',
  },
  {
    title: '高端商务企业简介与品牌介绍',
    category: '公司介绍',
    style: '高端 · 商务',
    image: businessReportImage,
    downloads: '980',
  },
  {
    title: '橙绿色简约风工作述职报告',
    category: '述职报告',
    style: '清新 · 现代',
    image: greenReportImage,
    downloads: '860',
  },
  {
    title: '极简留白产品发布会 PPT 模板',
    category: '产品发布',
    style: '极简 · 留白',
    image: minimalReportImage,
    downloads: '720',
  },
  {
    title: '蓝色简约论文答辩 PPT 模板',
    category: '毕业答辩',
    style: '学术 · 清晰',
    image: blueReportImage,
    downloads: '690',
  },
];

const popularTemplates = [
  { title: '简洁蓝色工作总结 PPT 模板免费下载', category: '工作总结', image: simpleBlueImage },
  { title: '蓝色简洁线条背景个人述职报告', category: '述职报告', image: reportLinesImage },
  { title: '小清新教育培训通用 PPT 模板', category: '教育培训', image: freshEducationImage },
];

function TemplateCard({ template }: { template: Template }) {
  return (
    <article className="ppt-template-card">
      <a
        className="ppt-template-cover"
        href="#template-preview"
        aria-label={`预览${template.title}`}
      >
        <img src={template.image} alt="" loading="lazy" />
        <span className="ppt-template-hover">
          查看模板 <ArrowRight size={15} />
        </span>
      </a>
      <div className="ppt-template-copy">
        <div className="ppt-template-meta">
          <span>{template.category}</span>
          <span>{template.style}</span>
        </div>
        <h3>{template.title}</h3>
        <div className="ppt-template-stats">
          <span>
            <Download size={14} /> {template.downloads} 次下载
          </span>
          <span className="ppt-template-format">PPTX</span>
        </div>
      </div>
    </article>
  );
}

function PptMaterialsHome() {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const loginFrameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!loginOpen) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = loginFrameRef.current?.contentWindow ?? null;
      if (!isValidPptAuthMessage(event, frameWindow)) {
        return;
      }

      completePptLogin();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLoginOpen(false);
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [loginOpen]);

  const visibleTemplates = useMemo(() => {
    const keyword = submittedQuery.trim().toLowerCase();
    if (!keyword) return templates;
    return templates.filter((template) =>
      `${template.title} ${template.category} ${template.style}`.toLowerCase().includes(keyword),
    );
  }, [submittedQuery]);

  const searchTemplates = (keyword: string) => {
    setQuery(keyword);
    setSubmittedQuery(keyword);
    document
      .getElementById('latest-templates')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    searchTemplates(query);
  };

  return (
    <div className="ppt-home">
      <header className="ppt-header">
        <div className="ppt-shell ppt-header-inner">
          <a className="ppt-brand" href="/" aria-label="PPT素材库首页">
            <span className="ppt-brand-mark">
              <LayoutGrid size={20} strokeWidth={2.4} />
            </span>
            <span>
              <strong>PPT</strong>素材库
            </span>
          </a>
          <nav
            id="ppt-main-navigation"
            className={`ppt-nav ${menuOpen ? 'ppt-nav--open' : ''}`}
            aria-label="主导航"
          >
            {categories.map((category, index) => (
              <a
                key={category}
                className={index === 0 ? 'ppt-nav-link ppt-nav-link--active' : 'ppt-nav-link'}
                href={index === 0 ? '#' : '#latest-templates'}
                onClick={() => setMenuOpen(false)}
              >
                {category}
                {category === '不止PPT' && <ChevronDown size={14} />}
              </a>
            ))}
          </nav>
          <button className="ppt-login" type="button" onClick={() => setLoginOpen(true)}>
            <LogIn size={16} /> 登录
          </button>
          <button
            className="ppt-menu-button"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="ppt-main-navigation"
            aria-label={menuOpen ? '关闭导航' : '打开导航'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </header>

      <main className="ppt-shell ppt-content">
        <div className="ppt-browse-bar">
          <div className="ppt-quick-tags" aria-label="热门搜索">
            <span>热门搜索：</span>
            {quickTags.slice(0, 5).map((tag) => (
              <button type="button" key={tag} onClick={() => searchTemplates(tag)}>
                {tag}
              </button>
            ))}
          </div>
          <form className="ppt-search" onSubmit={handleSearch} role="search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 PPT 模板"
              aria-label="搜索 PPT 素材"
            />
            <button type="submit" aria-label="搜索">
              <Search size={18} />
            </button>
          </form>
        </div>

        {noticeVisible && (
          <div className="ppt-notice">
            <span className="ppt-notice-label">素材分享</span>
            <p>PPT 模板、图表、背景与素材，按分类浏览，找到需要的内容。</p>
            <button type="button" aria-label="关闭提示" onClick={() => setNoticeVisible(false)}>
              <X size={16} />
            </button>
          </div>
        )}

        <section className="ppt-section" id="latest-templates" aria-labelledby="ppt-latest-heading">
          <div className="ppt-section-heading">
            <h1 id="ppt-latest-heading">
              {submittedQuery ? `搜索“${submittedQuery}”` : '最新PPT模板'}
            </h1>
            <button className="ppt-see-all" type="button" onClick={() => searchTemplates('')}>
              查看全部 <ArrowRight size={14} />
            </button>
          </div>
          {visibleTemplates.length > 0 ? (
            <div className="ppt-template-grid">
              {visibleTemplates.map((template) => (
                <TemplateCard key={template.title} template={template} />
              ))}
            </div>
          ) : (
            <div className="ppt-empty">
              没有找到匹配的模板。
              <button type="button" onClick={() => searchTemplates('')}>
                查看全部模板
              </button>
            </div>
          )}
        </section>

        <section className="ppt-section" id="all-templates" aria-labelledby="ppt-popular-heading">
          <div className="ppt-section-heading">
            <h2 id="ppt-popular-heading">
              <Download size={19} /> 热门PPT免费下载
            </h2>
            <a className="ppt-see-all" href="#latest-templates">
              查看全部 <ArrowRight size={14} />
            </a>
          </div>
          <div className="ppt-template-grid">
            {popularTemplates.map((template) => (
              <article className="ppt-template-card" key={template.title}>
                <a
                  className="ppt-template-cover"
                  href="#template-preview"
                  aria-label={`预览${template.title}`}
                >
                  <img src={template.image} alt="" loading="lazy" />
                  <span className="ppt-template-hover">
                    查看模板 <ArrowRight size={15} />
                  </span>
                </a>
                <div className="ppt-template-copy">
                  <div className="ppt-template-meta">
                    <span>{template.category}</span>
                    <span>免费PPT模板</span>
                  </div>
                  <h3>{template.title}</h3>
                  <div className="ppt-template-stats">
                    <span>
                      <Download size={14} /> 免费下载
                    </span>
                    <span className="ppt-template-format">PPTX · 可编辑</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="ppt-section ppt-tags-section" aria-labelledby="ppt-tags-heading">
          <div className="ppt-section-heading">
            <h2 id="ppt-tags-heading">标签</h2>
          </div>
          <div className="ppt-tag-cloud">
            {[
              ...quickTags,
              '蓝色PPT',
              '年终汇报',
              '项目计划',
              '企业介绍',
              '培训课件',
              '简历作品集',
            ].map((tag) => (
              <button type="button" key={tag} onClick={() => searchTemplates(tag)}>
                {tag}
              </button>
            ))}
          </div>
        </section>
      </main>

      <footer className="ppt-footer">
        <div className="ppt-shell ppt-footer-inner">
          <a className="ppt-brand ppt-brand--footer" href="/">
            <span className="ppt-brand-mark">
              <LayoutGrid size={18} />
            </span>
            <span>
              <strong>PPT</strong>素材库
            </span>
          </a>
          <span>PPT 模板 · 图表 · 素材 · 背景</span>
          <span className="ppt-footer-note">模板内容仅作展示</span>
        </div>
      </footer>
      <div id="template-preview" aria-hidden="true" />
      {loginOpen && (
        <div className="ppt-login-modal" role="presentation">
          <div
            className="ppt-login-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppt-login-title"
          >
            <h2 id="ppt-login-title" className="sr-only">
              登录 PPT 素材库
            </h2>
            <button
              className="ppt-login-close"
              type="button"
              aria-label="关闭登录弹窗"
              onClick={() => setLoginOpen(false)}
            >
              <X size={22} />
            </button>
            <iframe
              ref={loginFrameRef}
              title="原站登录"
              src={PPT_EMBEDDED_LOGIN_URL}
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default PptMaterialsHome;
