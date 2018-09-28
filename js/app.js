const onError = function (error) {
  if (error.message === undefined) {
    if (error.response && error.response.status === 401) {
      this.onError = { message: "Unauthorized Access. Please check your token." }
    } else {
      this.onError = { message: "Something went wrong. Make sure the configuration is ok and your Gitlab is up and running."}
    }
  } else {
    this.onError = { message: error.message }
  }

  console.log(this.onError.message)
}

function lastRun() {
  return moment().format('ddd, YYYY-MM-DD HH:mm:ss')
}

// Used by vue
// noinspection JSUnusedGlobalSymbols
const app = new Vue({
  el: '#app',
  data: {
    projects: {},
    pipelines: [],
    pipelinesMap: {},
    token: null,
    gitlab: null,
    repositories: null,
    loading: false,
    invalidConfig: false,
    lastRun: lastRun(),
    onError: null
  },
  created: function() {
    this.loadConfig()

    const error = this.validateConfig()
    if (error !== undefined) {
      onError.bind(this)(error)
      return
    }

    this.setupDefaults()

    this.fetchProjects()
    this.fetchGroups()

    var self = this
    setInterval(function() {
      self.updateBuilds()
  }, 60000)
  },
  methods: {
    loadConfig: function() {
      const self = this
      self.gitlab = getParameterByName("gitlab")
      self.token = getParameterByName("token")
      self.ref = getParameterByName("ref")
      self.blacklist = []
      self.repositories = []
      self.groups = []

      const blacklistParameter = getParameterByName("blacklist");
      if (blacklistParameter != null) {
        self.blacklist = getParameterByName("blacklist").split(",")
      }

      const repositoriesParameter = getParameterByName("projects")
      if (repositoriesParameter != null) {
        const uniqueRepos = {}
        let repositories = repositoriesParameter.split(",").forEach(function(repo) {
          uniqueRepos[repo.trim()] = true
        })
        repositories = Object.keys(uniqueRepos)
        for (const x in repositories) {
          try {
            const repository = repositories[x].split('/')
            let branch, projectName, nameWithNamespace
            if (repository.length < 3) { /* when no branch is defined */
              branch = ""
              projectName = repository[repository.length - 1].trim()
              nameWithNamespace = repository.join('/')
            }
            if (repository.length == 3) { /* when a branch is defined */
              branch = repository[repository.length - 1].trim()
              projectName = repository[repository.length - 2].trim()
              nameWithNamespace = repository.slice(0, repository.length - 1).join('/')
            }
            if (repository.length > 3) { /* when project are related to subgroups. defining a branch is MANDATORY */
              branch = repository.splice(repository.length - 1, 1)[0].trim()
              projectName = repository.splice(repository.length - 1, 1)[0].trim()
              nameWithNamespace = repository.concat(projectName).join('/')
            }

            self.repositories.push({
              nameWithNamespace: nameWithNamespace,
              projectName: projectName,
              branch: branch,
              key: nameWithNamespace + '/' + branch
            })
          } catch (err) {
            onError.bind(self)({ message: "Wrong projects format! Try: 'namespace/project/branch'", response: { status: 500 } })
          }
        }
      }
      const groupsParameter = getParameterByName("groups")
      if (groupsParameter != null) {
        self.groups = groupsParameter.split(",")
      }
    },
    blacklisted: function(project) {
        for (var i = 0; i < this.blacklist.length; i++) {
            if (this.blacklist[i] == project) {
                return true;
            }
        }
        return false;
    },
    statusPriority: function(status) {
        switch (status) {
            case "failed":
                return 1;
            case "running":
                return 2;
            case "pending":
                return 3;
            case "canceled":
                return 4;
            case "rotten":
                return 5;
            default:
                return 6;
        }
    },
    validateConfig: function() {
      const error = { response: { status: 500 } }
      if (this.repositories.length === 0 && this.groups.length === 0) {
        error.message = "You need to set projects or groups"
        return error
      } else if (this.repositories === null || this.token === null || this.gitlab === null && this.token !== "use_cookie") {
        error.message = "Wrong format"
        return error
      }
    },
    setupDefaults: function() {
      if (this.token !== "use_cookie") {
        axios.defaults.baseURL = "https://" + this.gitlab + "/api/v4"
        axios.defaults.headers.common['PRIVATE-TOKEN'] = this.token
      } else {
        // Running on the GitLab-Server...
        axios.defaults.baseURL = "/api/v4"
        this.gitlab = location.hostname
      }
    },
    fetchProjects: function() {
      const self = this
      self.repositories.forEach(function(repository) {
        self.loading = true
        axios.get('/projects/' + repository.nameWithNamespace.replace(/\//g, '%2F'))
          .then(function (response) {
            self.loading = false
            if (repository.branch === "") {
              repository.branch = response.data.default_branch
            }
            const project = { project: repository, data: response.data }
            if (self.projects[repository.key] === undefined) {
              self.projects[repository.key] = project
              self.fetchBuild(project)
            }
          })
          .catch(onError.bind(self))
      })
    },
    fetchGroups: function() {
      const self = this
      self.groups.forEach(function(g) {
        self.loading = true
        axios.get('/groups/' + g)
          .then(function (response) {
            self.loading = false
            response.data.projects.forEach(function(project) {
              if (project.jobs_enabled && !project.archived && !self.blacklisted(project.name)) {
                const branch = project.default_branch
                const projectName = project.name
                const nameWithNamespace = project.path_with_namespace
                const data = {
                  nameWithNamespace: nameWithNamespace,
                  projectName: projectName,
                  branch: branch,
                  key: nameWithNamespace + '/' + branch
                }
                const p = { project: data, data: project }
                if (self.projects[project.path_with_namespace] === undefined) {
                  self.projects[project.path_with_namespace] = p
                  self.fetchBuild(p)
                }
              }
            })
          }).catch(onError.bind(self))
      })
    },
    updateBuilds: function() {
      const self = this
      self.onError = null
      Object.values(self.projects).forEach(function(p) { self.fetchBuild(p) })
      self.lastRun = lastRun()
      self.pipelines.sort(function(a, b) {
          if (self.statusPriority(a.status) != self.statusPriority(b.status)) {
              return self.statusPriority(a.status) - self.statusPriority(b.status);
          }
          return a.project.localeCompare(b.project)
      })
    },
    fetchBuild: function(p) {
      const self = this

      axios.get('/projects/' + p.data.id + '/pipelines/?ref=' + p.project.branch)
        .then(function(pipelines) {
          if (pipelines.data.length === 0) {
            return
          }
          const commitId = pipelines.data[0].sha
          const pipelineId = pipelines.data[0].id
          axios.get('/projects/' + p.data.id + '/repository/commits/' + commitId)
            .then(function(commit) {
              self.updateBuildInfo(p, commit, pipelineId)
            })
            .catch(onError.bind(self))
        })
        .catch(onError.bind(self))
    },
    updateBuildInfo: function(p, commit, pipelineId) {
      const self = this
      const rottenThreshold = 2 * 24 * 60 * 60 * 1000; // no build since 2 days => rotten
      axios.get('/projects/' + p.data.id + '/pipelines/' + pipelineId)
        .then(function(pipeline) {
          const startedAt = pipeline.data.started_at
          const startedFromNow = moment(startedAt).fromNow()
          const b = self.pipelinesMap[p.project.key]
          if (b !== undefined) {
            b.id = pipeline.data.id
            b.status = Date.now() - Date.parse(startedAt) >= rottenThreshold ? "rotten" : pipeline.data.status
            b.started_from_now = startedFromNow
            b.started_at = startedAt
            b.author = commit.data.author_name
            b.title = commit.data.title
            b.sha1 = commit.data.id
          } else {
            const project = {
              project: p.project.projectName,
              id: pipeline.data.id,
              status: Date.now() - Date.parse(startedAt) >= rottenThreshold ? "rotten" : pipeline.data.status,
              started_from_now: startedFromNow,
              started_at: startedAt,
              author: commit.data.author_name,
              project_path: p.project.nameWithNamespace,
              branch: p.project.branch,
              title: commit.data.title,
              sha1: commit.data.id
            }
            self.pipelines.push(project)
            self.pipelinesMap[p.project.key] = project
          }
        })
        .catch(onError.bind(self))
    }
  }
})
