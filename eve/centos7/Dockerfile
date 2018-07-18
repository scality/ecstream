FROM centos:7

ENV HOME_BUILDBOT /var/lib/buildbot

#
# Install packages needed by the buildchain
#

RUN yum install -y epel-release
RUN yum clean all && yum install -y \
    ca-certificates \
    gcc \
    git \
    openssh-client \
    python \
    python-devel \
    python-pip \
    python-pkg-resources \
    python-setuptools \
    sudo \
    wget \
    npm

RUN pip install --upgrade pip
RUN git config --global credential.helper store

#
# Add user eve
#

RUN adduser -u 1042 --create-home --comment "" eve #\
# && adduser eve sudo \
# && echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

#
# Eve configuration
#

USER eve

RUN mkdir -p /home/eve/workspace \
    && mkdir -p /home/eve/.ssh/ \
    && /bin/echo -e "Host bitbucket.org\n\tStrictHostKeyChecking no\n" >> /home/eve/.ssh/config

ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

ENV BUILD_DISTRO=centos7

#
# Run buildbot-worker on startup
#

ARG BUILDBOT_VERSION
RUN sudo pip install buildbot-worker==$BUILDBOT_VERSION

WORKDIR /home/eve/workspace
CMD buildbot-worker create-worker . "$BUILDMASTER:$BUILDMASTER_PORT" "$WORKERNAME" "$WORKERPASS" \
    && buildbot-worker start --nodaemon
