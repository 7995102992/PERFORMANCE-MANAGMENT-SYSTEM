package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateKraEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsGoalTemplateKraRepository extends JpaRepository<PmsGoalTemplateKraEntity, UUID> {
}
