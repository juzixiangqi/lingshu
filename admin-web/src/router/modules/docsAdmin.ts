const Layout = () => import("@/layout/index.vue");

export default {
  path: "/docs-admin",
  name: "DocsAdmin",
  component: Layout,
  redirect: "/docs-admin/documents",
  meta: {
    icon: "ep/document",
    title: "文档协同",
    rank: 1
  },
  children: [
    {
      path: "/docs-admin/documents",
      name: "DocsAdminDocuments",
      component: () => import("@/views/docs-admin/index.vue"),
      meta: {
        title: "文档总览"
      }
    },
    {
      path: "/docs-admin/recycle",
      name: "DocsAdminRecycle",
      component: () => import("@/views/docs-admin/recycle.vue"),
      meta: {
        title: "回收站"
      }
    },
    {
      path: "/docs-admin/users",
      name: "DocsAdminUsers",
      component: () => import("@/views/docs-admin/users.vue"),
      meta: {
        title: "用户检索"
      }
    },
    {
      path: "/docs-admin/audit",
      name: "DocsAdminAudit",
      component: () => import("@/views/docs-admin/audit.vue"),
      meta: {
        title: "审计日志"
      }
    },
    {
      path: "/docs-admin/shards",
      name: "DocsAdminShards",
      component: () => import("@/views/docs-admin/shards.vue"),
      meta: {
        title: "运行状态"
      }
    }
  ]
} satisfies RouteConfigsTable;
