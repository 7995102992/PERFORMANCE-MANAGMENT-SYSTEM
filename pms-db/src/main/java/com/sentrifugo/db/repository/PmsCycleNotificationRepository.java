package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleNotificationEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsCycleNotificationRepository extends JpaRepository<PmsCycleNotificationEntity, UUID> {
}
