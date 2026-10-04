package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateKpiEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsGoalTemplateKpiRepository extends JpaRepository<PmsGoalTemplateKpiEntity, UUID> {
}
